import { afterEach, beforeEach, expect, test } from "@yaffle/test"

import { Hono } from "hono"
import { eq, sql } from "drizzle-orm"

import { createOrg } from "../db/queries/organizations.ts"
import { createRunGroup } from "../db/queries/run-groups.ts"
import { completeJobFromRunner } from "../db/queries/iac-jobs.ts"
import {
  iacJobHistory,
  iacJobs,
  previews,
  resourceSpans,
  runGroups,
  tfRuns,
  workspaceDeployments,
} from "../db/schema.ts"
import { cleanupTestData } from "../test-utils/auth.ts"
import { createTestRunCapability } from "../test-utils/runner-capability.ts"
import { db } from "../lib/db.ts"
import type { ExecutionSnapshotV1 } from "../lib/execution-snapshot.ts"
import { generateJobToken } from "../lib/job-token.ts"
import { resolveActiveRunCapability } from "../lib/runner-capability.ts"
import { ensureNamedWorkspace } from "../lib/workspace-service.ts"
import { runnerRoute } from "./runner.ts"

process.env.YAFFLE_PUBLIC_API_URL ??= "http://localhost:3000"
process.env.BETTER_AUTH_SECRET ??= "runner-context-test-secret-at-least-32-characters"

const app = new Hono()
app.route("/api/runner", runnerRoute)

function executionSnapshot(input: {
  repo: string
  ref: string
  headSha: string
  environmentKind?: "named" | "transient"
  environmentName: string
  prNumber: number | null
  workspacePath: string
}): ExecutionSnapshotV1 {
  return {
    version: 1,
    source: {
      installationId: 1,
      repositoryId: 2,
      ownerId: 3,
      owner: "acme",
      repository: input.repo,
      defaultBranch: "main",
      ref: input.ref,
      commitSha: input.headSha,
      baseSha: null,
      actor: { githubId: 4, login: "builder" },
    },
    configuration: {
      path: "yaffle.toml",
      revision: input.headSha,
      digest: "runner-context-config-digest",
    },
    environment: {
      kind: input.environmentKind ?? "transient",
      name: input.environmentName,
      sourcePullRequestNumber: input.prNumber,
    },
    workspaces: [
      {
        path: input.workspacePath,
        variables: {},
        approval: { required: false, approvers: [] },
        lifecycle: { activation: [], verification: [] },
        automaticPreviewIsolation: false,
      },
    ],
  }
}

beforeEach(async () => {
  await cleanupTestData()
})

afterEach(async () => {
  await cleanupTestData()
})

test("does not expose or claim a transient job without a valid execution context", async () => {
  const org = await createOrg({
    name: "Invalid Runner Context",
    slug: `invalid-runner-context-${crypto.randomUUID()}`,
  })
  const [deployment] = await db
    .insert(previews)
    .values({
      orgId: org.id,
      repo: "fixture",
      environmentKind: "transient",
      environmentName: "pr-9",
      prNumber: 9,
      workspacePath: "infra",
      ref: "refs/heads/feature/invalid-context",
      headSha: "invalid-context-sha",
      stateKey: "previews/pr-9/terraform.tfstate",
      mode: "saas",
    })
    .returning()
  const jobId = crypto.randomUUID()
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: deployment.repo,
    environmentKind: "transient",
    environmentName: deployment.environmentName,
    prNumber: deployment.prNumber,
    ref: deployment.ref,
    headSha: deployment.headSha,
    trigger: "pr_opened",
    status: "failed",
  })
  await db.execute(sql`
    INSERT INTO iac_jobs (id, deployment_id, run_group_id, job_type, status)
    VALUES (${jobId}, ${deployment.id}, ${runGroup.id}, 'plan', 'queued')
  `)
  const token = await generateJobToken(jobId, deployment.id, org.id)
  const headers = { authorization: `Bearer ${token}` }

  const detailsResponse = await app.request(`/api/runner/job/${jobId}`, { headers })
  expect(detailsResponse.status).toBe(409)
  expect(await detailsResponse.json()).toMatchObject({
    error: { code: "EXECUTION_CONTEXT_INVALID" },
  })

  const claimResponse = await app.request("/api/runner/claim", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jobId, workerId: "test-worker" }),
  })
  expect(claimResponse.status).toBe(409)
  expect(await claimResponse.json()).toMatchObject({
    error: { code: "EXECUTION_CONTEXT_INVALID" },
  })

  const [persistedJob] = await db.select().from(iacJobs)
  expect(persistedJob.status).toBe("queued")
})

test("rejects a heartbeat when the token does not own the job deployment and organization", async () => {
  const org = await createOrg({
    name: "Runner Heartbeat Owner",
    slug: `runner-heartbeat-owner-${crypto.randomUUID()}`,
  })
  const foreignOrg = await createOrg({
    name: "Runner Heartbeat Foreign",
    slug: `runner-heartbeat-foreign-${crypto.randomUUID()}`,
  })
  const [deployment] = await db
    .insert(previews)
    .values({
      orgId: org.id,
      repo: "fixture",
      environmentKind: "transient",
      environmentName: "pr-10",
      prNumber: 10,
      workspacePath: "infra",
      ref: "refs/heads/feature/heartbeat-context",
      headSha: "heartbeat-context-sha",
      stateKey: "previews/pr-10/terraform.tfstate",
      mode: "saas",
    })
    .returning()
  const jobId = crypto.randomUUID()
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: deployment.repo,
    environmentKind: "transient",
    environmentName: deployment.environmentName,
    prNumber: deployment.prNumber,
    ref: deployment.ref,
    headSha: deployment.headSha,
    trigger: "pr_opened",
    status: "running",
    executionSnapshot: executionSnapshot({
      repo: deployment.repo,
      ref: deployment.ref,
      headSha: deployment.headSha,
      environmentName: deployment.environmentName,
      prNumber: deployment.prNumber!,
      workspacePath: deployment.workspacePath,
    }),
  })
  await db.update(previews).set({ runGroupId: runGroup.id }).where(eq(previews.id, deployment.id))
  await db.execute(sql`
    INSERT INTO iac_jobs (
      id,
      deployment_id,
      run_group_id,
      job_type,
      status,
      worker_id,
      started_at,
      last_heartbeat
    )
    VALUES (
      ${jobId},
      ${deployment.id},
      ${runGroup.id},
      'plan',
      'running',
      'test-worker',
      NOW(),
      NOW() - INTERVAL '1 minute'
    )
  `)
  const previousHeartbeat = (
    await db.select({ lastHeartbeat: iacJobs.lastHeartbeat }).from(iacJobs)
  )[0].lastHeartbeat
  const token = await generateJobToken(jobId, crypto.randomUUID(), foreignOrg.id)

  const response = await app.request("/api/runner/heartbeat", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jobId, runId: crypto.randomUUID() }),
  })

  expect(response.status).toBe(403)
  const [persistedJob] = await db.select({ lastHeartbeat: iacJobs.lastHeartbeat }).from(iacJobs)
  expect(persistedJob.lastHeartbeat).toEqual(previousHeartbeat)
})

test("revokes job details and execution context when the job completes", async () => {
  const org = await createOrg({
    name: "Completed Runner Capability",
    slug: `completed-runner-capability-${crypto.randomUUID()}`,
  })
  const [deployment] = await db
    .insert(previews)
    .values({
      orgId: org.id,
      repo: "fixture",
      environmentKind: "named",
      environmentName: "staging",
      prNumber: null,
      workspacePath: "infra",
      ref: "refs/heads/feature/completed-capability",
      headSha: "completed-capability-sha",
      stateKey: "environments/staging/terraform.tfstate",
      mode: "saas",
    })
    .returning()
  const jobId = crypto.randomUUID()
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: deployment.repo,
    environmentKind: "named",
    environmentName: deployment.environmentName,
    prNumber: deployment.prNumber,
    ref: deployment.ref,
    headSha: deployment.headSha,
    trigger: "pr_opened",
    status: "running",
    workspaceS3Key: `run-groups/${crypto.randomUUID()}/workspace.tar.gz`,
    executionSnapshot: executionSnapshot({
      repo: deployment.repo,
      ref: deployment.ref,
      headSha: deployment.headSha,
      environmentKind: "named",
      environmentName: deployment.environmentName,
      prNumber: deployment.prNumber,
      workspacePath: deployment.workspacePath,
    }),
  })
  await db.update(previews).set({ runGroupId: runGroup.id }).where(eq(previews.id, deployment.id))
  await db.execute(sql`
    INSERT INTO iac_jobs (
      id,
      deployment_id,
      run_group_id,
      job_type,
      status,
      worker_id,
      started_at,
      last_heartbeat
    )
    VALUES (
      ${jobId},
      ${deployment.id},
      ${runGroup.id},
      'plan',
      'running',
      'test-worker',
      NOW(),
      NOW()
    )
  `)
  const runId = crypto.randomUUID()
  await db.insert(tfRuns).values({
    id: runId,
    jobId,
    deploymentId: deployment.id,
    runGroupId: runGroup.id,
    runType: "plan",
    status: "running",
    startedAt: new Date(),
  })
  const token = await generateJobToken(jobId, deployment.id, org.id)
  await completeJobFromRunner({ jobId, deploymentId: deployment.id, runGroupId: runGroup.id }, {})
  const headers = { authorization: `Bearer ${token}` }

  const detailsResponse = await app.request(`/api/runner/job/${jobId}`, { headers })
  expect(detailsResponse.status).toBe(403)

  const contextResponse = await app.request(`/api/runner/job/${jobId}/context`, { headers })
  expect(contextResponse.status).toBe(403)

  const terminalCallbacks = await Promise.all([
    app.request("/api/runner/logs", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jobId, runId, chunk: "must not be stored" }),
    }),
    app.request("/api/runner/spans", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jobId, runId, events: [] }),
    }),
    app.request("/api/runner/heartbeat", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jobId, runId }),
    }),
    app.request("/api/runner/plan-file-url", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    }),
    app.request("/api/runner/complete", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jobId, runId, status: "completed", result: {} }),
    }),
  ])
  expect(terminalCallbacks.map((response) => response.status)).toEqual([403, 403, 403, 403, 403])
})

test("rejects every runner write surface outside the token's exact run", async () => {
  const org = await createOrg({
    name: "Exact Runner Capability",
    slug: `exact-runner-capability-${crypto.randomUUID()}`,
  })
  const createCapability = async (suffix: string) => {
    const workspace = await ensureNamedWorkspace({
      orgId: org.id,
      orgSlug: org.slug,
      repo: `fixture-${suffix}`,
      environment: `staging-${suffix}`,
      ref: `refs/heads/${suffix}`,
      workspacePath: "infra",
    })
    return createTestRunCapability(`runner-write-${suffix}`, workspace.id, org.id)
  }
  const own = await createCapability("own")
  const foreign = await createCapability("foreign")
  const siblingJobId = crypto.randomUUID()
  const siblingRunId = crypto.randomUUID()
  await db.insert(iacJobs).values({
    id: siblingJobId,
    deploymentId: own.deploymentId,
    runGroupId: own.runGroupId,
    jobType: "plan",
    status: "running",
    workerId: "sibling-runner",
    startedAt: new Date(),
  })
  await db.insert(tfRuns).values({
    id: siblingRunId,
    jobId: siblingJobId,
    deploymentId: own.deploymentId,
    runGroupId: own.runGroupId,
    runType: "plan",
    status: "running",
    startedAt: new Date(),
  })
  const token = await generateJobToken(own.jobId, own.deploymentId, org.id)
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  }
  const post = async (path: string, body: unknown): Promise<Response> =>
    await app.request(`/api/runner${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

  const attempts = [
    await post("/claim", { jobId: foreign.jobId, workerId: "foreign-worker" }),
    await post("/logs", {
      jobId: own.jobId,
      runId: siblingRunId,
      chunk: "must not be stored",
    }),
    await post("/spans", {
      jobId: own.jobId,
      runId: siblingRunId,
      events: [
        {
          resourceAddress: "aws_s3_bucket.foreign",
          resourceType: "aws_s3_bucket",
          action: "create",
          event: "started",
          timestamp: Date.now(),
        },
      ],
    }),
    await post("/complete", {
      jobId: own.jobId,
      runId: siblingRunId,
      status: "completed",
      result: {},
    }),
    await post("/heartbeat", { jobId: own.jobId, runId: siblingRunId }),
    await post("/plan-file-url", { runId: siblingRunId }),
    await post("/logs", {
      jobId: own.jobId,
      runId: foreign.runId,
      chunk: "must not cross deployments",
    }),
    await post("/spans", { jobId: own.jobId, runId: foreign.runId, events: [] }),
    await post("/complete", {
      jobId: own.jobId,
      runId: foreign.runId,
      status: "completed",
      result: {},
    }),
    await post("/heartbeat", { jobId: own.jobId, runId: foreign.runId }),
    await post("/plan-file-url", { runId: foreign.runId }),
  ]

  expect(attempts.map((response) => response.status)).toEqual([
    403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403,
  ])

  const [foreignJob] = await db
    .select({ status: iacJobs.status, workerId: iacJobs.workerId })
    .from(iacJobs)
    .where(eq(iacJobs.id, foreign.jobId))
  expect(foreignJob).toEqual({ status: "running", workerId: "test-runner" })

  const [siblingRun] = await db
    .select({ status: tfRuns.status, logOutput: tfRuns.logOutput })
    .from(tfRuns)
    .where(eq(tfRuns.id, siblingRunId))
  expect(siblingRun).toEqual({ status: "running", logOutput: null })

  const foreignSpanRows = await db
    .select({ id: resourceSpans.id })
    .from(resourceSpans)
    .where(eq(resourceSpans.runId, siblingRunId))
  expect(foreignSpanRows).toHaveLength(0)
})

test("atomically settles the exact job and run through the completion endpoint", async () => {
  const org = await createOrg({
    name: "Runner Settlement",
    slug: `runner-settlement-${crypto.randomUUID()}`,
  })
  const workspace = await ensureNamedWorkspace({
    orgId: org.id,
    orgSlug: org.slug,
    repo: "settlement-fixture",
    environment: "staging",
    ref: "refs/heads/main",
    workspacePath: "infra",
  })
  const capability = await createTestRunCapability("runner-settlement", workspace.id, org.id)
  const token = await generateJobToken(capability.jobId, capability.deploymentId, org.id)
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  }

  const foreignArtifactResponse = await app.request("/api/runner/complete", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jobId: capability.jobId,
      runId: capability.runId,
      status: "completed",
      result: {
        planSummary: "+1, ~0, -0",
        hasChanges: true,
        planFileS3Key: `plan-files/${crypto.randomUUID()}/${crypto.randomUUID()}/tfplan`,
      },
    }),
  })
  expect(foreignArtifactResponse.status).toBe(403)

  const conflictingResultResponse = await app.request("/api/runner/complete", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jobId: capability.jobId,
      runId: capability.runId,
      status: "completed",
      result: { planSummary: "+1, ~0, -0", hasChanges: false },
    }),
  })
  expect(conflictingResultResponse.status).toBe(409)

  const missingArtifactResponse = await app.request("/api/runner/complete", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jobId: capability.jobId,
      runId: capability.runId,
      status: "completed",
      result: { planSummary: "+1, ~0, -0", hasChanges: true },
    }),
  })
  expect(missingArtifactResponse.status).toBe(409)

  const response = await app.request("/api/runner/complete", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jobId: capability.jobId,
      runId: capability.runId,
      status: "completed",
      result: {
        planSummary: "+0, ~0, -0",
        hasChanges: false,
      },
      logOutput: "plan completed",
    }),
  })

  expect(response.status).toBe(200)
  expect(await db.select().from(iacJobs).where(eq(iacJobs.id, capability.jobId))).toHaveLength(0)
  const [archivedJob] = await db
    .select({ status: iacJobHistory.status })
    .from(iacJobHistory)
    .where(eq(iacJobHistory.id, capability.jobId))
  expect(archivedJob.status).toBe("completed")
  const [settledRun] = await db
    .select({ status: tfRuns.status, jobId: tfRuns.jobId, logOutput: tfRuns.logOutput })
    .from(tfRuns)
    .where(eq(tfRuns.id, capability.runId))
  expect(settledRun).toEqual({
    status: "success",
    jobId: capability.jobId,
    logOutput: "plan completed",
  })
})

test("rejects cross-tenant mutation on every runner callback", async () => {
  const ownerOrg = await createOrg({
    name: "Runner Owner Tenant",
    slug: `runner-owner-${crypto.randomUUID()}`,
  })
  const foreignOrg = await createOrg({
    name: "Runner Foreign Tenant",
    slug: `runner-foreign-${crypto.randomUUID()}`,
  })
  const createCapability = async (org: typeof ownerOrg, label: string) => {
    const workspace = await ensureNamedWorkspace({
      orgId: org.id,
      orgSlug: org.slug,
      repo: `${label}-fixture`,
      environment: "staging",
      ref: "refs/heads/main",
      workspacePath: "infra",
    })
    return createTestRunCapability(`cross-tenant-${label}`, workspace.id, org.id)
  }
  const owner = await createCapability(ownerOrg, "owner")
  const foreign = await createCapability(foreignOrg, "foreign")
  const token = await generateJobToken(owner.jobId, owner.deploymentId, ownerOrg.id)
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  }
  const post = async (path: string, body: unknown): Promise<Response> =>
    await app.request(`/api/runner${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

  const responses = await Promise.all([
    post("/claim", { jobId: foreign.jobId, workerId: "cross-tenant-worker" }),
    post("/logs", { jobId: owner.jobId, runId: foreign.runId, chunk: "forbidden" }),
    post("/spans", { jobId: owner.jobId, runId: foreign.runId, events: [] }),
    post("/heartbeat", { jobId: owner.jobId, runId: foreign.runId }),
    post("/complete", {
      jobId: owner.jobId,
      runId: foreign.runId,
      status: "completed",
      result: {},
    }),
    post("/plan-file-url", { runId: foreign.runId }),
  ])

  expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403])
})

test("revokes runner and TFC capabilities when a deployment moves to another run group", async () => {
  const org = await createOrg({
    name: "Rebound Capability",
    slug: `rebound-capability-${crypto.randomUUID()}`,
  })
  const workspace = await ensureNamedWorkspace({
    orgId: org.id,
    orgSlug: org.slug,
    repo: "rebound-fixture",
    environment: "staging",
    ref: "refs/heads/main",
    workspacePath: "infra",
  })
  const capability = await createTestRunCapability("rebound-capability", workspace.id, org.id)
  const [newRunGroup] = await db
    .insert(runGroups)
    .values({
      orgId: org.id,
      repo: workspace.repo,
      environmentKind: workspace.environmentKind,
      environmentName: workspace.environmentName,
      ref: workspace.ref,
      headSha: "rebound-capability-sha",
      selectedWorkspacePaths: [workspace.workspacePath],
      trigger: "manual",
      status: "running",
    })
    .returning()
  await db
    .update(workspaceDeployments)
    .set({ runGroupId: newRunGroup.id })
    .where(eq(workspaceDeployments.id, capability.deploymentId))

  const jobToken = await generateJobToken(capability.jobId, capability.deploymentId, org.id)
  const logResponse = await app.request("/api/runner/logs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${jobToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jobId: capability.jobId,
      runId: capability.runId,
      chunk: "must not be stored",
    }),
  })
  expect(logResponse.status).toBe(403)

  expect(
    await resolveActiveRunCapability({
      runId: capability.runId,
      jobId: capability.jobId,
      deploymentId: capability.deploymentId,
      runGroupId: capability.runGroupId,
      workspaceId: workspace.id,
      orgId: org.id,
    }),
  ).toBeNull()
})
