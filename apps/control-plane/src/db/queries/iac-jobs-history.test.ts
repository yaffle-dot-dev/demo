import { afterEach, describe, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { cleanupTestData, createTestUser } from "../../test-utils/auth.ts"
import { approvals, iacJobHistory, iacJobs, previews, tfRuns } from "../schema.ts"
import { createApproval, listApprovals } from "./approvals.ts"
import { createOrg } from "./organizations.ts"
import { createRunGroup } from "./run-groups.ts"
import { ExecutionContextAssociationError } from "../../lib/execution-snapshot.ts"
import {
  cancelJobsForDeployment,
  cancelRunningJobForDeploymentAndType,
  claimJobForRunner,
  completeJobFromRunner,
  createIacJob,
  failStaleJob,
  findIacJobById,
  findLatestJobForDeployment,
  findPendingJobsForDeployment,
  getJobWithContext,
} from "./iac-jobs.ts"

async function createTestDeployment() {
  const org = await createOrg({
    name: "IaC Jobs Test Org",
    slug: `iac-jobs-test-${crypto.randomUUID().slice(0, 8)}`,
    membershipMode: "invite_only",
  })
  const environmentName = `main-${crypto.randomUUID().slice(0, 8)}`
  const headSha = crypto.randomUUID().replaceAll("-", "")
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: "test-repo",
    environmentKind: "named",
    environmentName,
    ref: "refs/heads/main",
    headSha,
    trigger: "manual",
    status: "pending",
  })

  const rows = await db
    .insert(previews)
    .values({
      orgId: org.id,
      runGroupId: runGroup.id,
      repo: "test-repo",
      environmentKind: "named",
      environmentName,
      prNumber: null,
      workspacePath: "infra",
      ref: "refs/heads/main",
      headSha,
      status: "pending",
      stateKey: `main/${crypto.randomUUID().slice(0, 8)}/terraform.tfstate`,
      mode: "terraform",
    })
    .returning()

  return rows[0]
}

function runnerCapability(job: { id: string; deploymentId: string; runGroupId: string | null }): {
  jobId: string
  deploymentId: string
  runGroupId: string
} {
  if (!job.runGroupId) {
    throw new Error("Test job is missing its run group")
  }
  return {
    jobId: job.id,
    deploymentId: job.deploymentId,
    runGroupId: job.runGroupId,
  }
}

afterEach(async () => {
  await cleanupTestData()
})

describe("iac job active/history split", () => {
  test("runner mutations require the exact job deployment and run group", async () => {
    const deployment = await createTestDeployment()
    const job = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })
    const wrongCapability = {
      jobId: job.id,
      deploymentId: crypto.randomUUID(),
      runGroupId: crypto.randomUUID(),
    }

    expect((await claimJobForRunner(wrongCapability, "foreign-worker")).claimed).toBe(false)

    const capability = runnerCapability(job)
    expect((await claimJobForRunner(capability, "owner-worker")).claimed).toBe(true)
    expect((await completeJobFromRunner(wrongCapability, {})).success).toBe(false)

    const [persistedJob] = await db
      .select({ status: iacJobs.status, workerId: iacJobs.workerId })
      .from(iacJobs)
      .where(eq(iacJobs.id, job.id))
    expect(persistedJob).toEqual({ status: "running", workerId: "owner-worker" })
  })

  test("run cancellation targets the exact job capability", async () => {
    const deployment = await createTestDeployment()
    const firstJob = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })
    const secondJob = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })
    const firstCapability = runnerCapability(firstJob)
    const secondCapability = runnerCapability(secondJob)
    await claimJobForRunner(firstCapability, "worker-a")
    await claimJobForRunner(secondCapability, "worker-b")
    const firstRunId = crypto.randomUUID()
    const secondRunId = crypto.randomUUID()
    await db.insert(tfRuns).values([
      {
        id: firstRunId,
        jobId: firstJob.id,
        deploymentId: deployment.id,
        runGroupId: firstCapability.runGroupId,
        runType: "plan",
        status: "running",
      },
      {
        id: secondRunId,
        jobId: secondJob.id,
        deploymentId: deployment.id,
        runGroupId: secondCapability.runGroupId,
        runType: "plan",
        status: "running",
      },
    ])

    const cancelled = await cancelRunningJobForDeploymentAndType({
      ...firstCapability,
      runId: firstRunId,
      jobType: "plan",
      errorMessage: "Cancelled by test",
    })

    expect(cancelled?.id).toBe(firstJob.id)
    expect(await db.select().from(iacJobs).where(eq(iacJobs.id, firstJob.id))).toHaveLength(0)
    const [secondPersisted] = await db
      .select({ status: iacJobs.status, workerId: iacJobs.workerId })
      .from(iacJobs)
      .where(eq(iacJobs.id, secondJob.id))
    expect(secondPersisted).toEqual({ status: "running", workerId: "worker-b" })
    const [secondRun] = await db
      .select({ status: tfRuns.status })
      .from(tfRuns)
      .where(eq(tfRuns.id, secondRunId))
    expect(secondRun.status).toBe("running")
  })

  test("stale cleanup fails only the run bound to the stale job", async () => {
    const deployment = await createTestDeployment()
    const staleJob = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })
    const siblingJob = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })
    const staleCapability = runnerCapability(staleJob)
    const siblingCapability = runnerCapability(siblingJob)
    await claimJobForRunner(staleCapability, "stale-worker")
    await claimJobForRunner(siblingCapability, "active-worker")
    const staleRunId = crypto.randomUUID()
    const siblingRunId = crypto.randomUUID()
    await db.insert(tfRuns).values([
      {
        id: staleRunId,
        jobId: staleJob.id,
        deploymentId: deployment.id,
        runGroupId: staleCapability.runGroupId,
        runType: "plan",
        status: "running",
      },
      {
        id: siblingRunId,
        jobId: siblingJob.id,
        deploymentId: deployment.id,
        runGroupId: siblingCapability.runGroupId,
        runType: "plan",
        status: "running",
      },
    ])
    await db
      .update(iacJobs)
      .set({ lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(iacJobs.id, staleJob.id))

    expect((await failStaleJob(staleJob.id)).failed).toBe(true)

    const runs = await db
      .select({ id: tfRuns.id, status: tfRuns.status })
      .from(tfRuns)
      .where(eq(tfRuns.deploymentId, deployment.id))
    expect(runs).toContainEqual({ id: staleRunId, status: "failed" })
    expect(runs).toContainEqual({ id: siblingRunId, status: "running" })
  })

  test("completeJobFromRunner archives terminal jobs and keeps lookups working", async () => {
    const deployment = await createTestDeployment()
    const job = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })

    const capability = runnerCapability(job)
    const claimResult = await claimJobForRunner(capability, "worker-a")
    expect(claimResult.claimed).toBe(true)

    const completionResult = await completeJobFromRunner(capability, {
      planSummary: "+1, ~0, -0",
    })
    expect(completionResult.success).toBe(true)
    expect(completionResult.job?.status).toBe("completed")

    const activeRows = await db.select().from(iacJobs).where(eq(iacJobs.id, job.id))
    const historyRows = await db.select().from(iacJobHistory).where(eq(iacJobHistory.id, job.id))

    expect(activeRows).toHaveLength(0)
    expect(historyRows).toHaveLength(1)
    expect(historyRows[0]?.status).toBe("completed")

    const foundJob = await findIacJobById(job.id)
    expect(foundJob?.status).toBe("completed")

    const latestJob = await findLatestJobForDeployment(deployment.id)
    expect(latestJob?.id).toBe(job.id)
    expect(latestJob?.status).toBe("completed")

    const jobContext = await getJobWithContext(job.id)
    expect(jobContext?.deployment.id).toBe(deployment.id)
    expect(jobContext?.status).toBe("completed")
  })

  test("cancelJobsForDeployment archives queued and running jobs", async () => {
    const deployment = await createTestDeployment()
    const queuedJob = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })
    const runningJob = await createIacJob({ deploymentId: deployment.id, jobType: "apply" })

    const claimResult = await claimJobForRunner(runnerCapability(runningJob), "worker-a")
    expect(claimResult.claimed).toBe(true)

    const cancelledCount = await cancelJobsForDeployment(deployment.id)
    expect(cancelledCount).toBe(2)

    const activeRows = await db
      .select()
      .from(iacJobs)
      .where(eq(iacJobs.deploymentId, deployment.id))
    const historyRows = await db
      .select()
      .from(iacJobHistory)
      .where(eq(iacJobHistory.deploymentId, deployment.id))

    expect(activeRows).toHaveLength(0)
    expect(historyRows).toHaveLength(2)
    expect(historyRows.map((row) => row.id).sort()).toEqual([queuedJob.id, runningJob.id].sort())
    expect(historyRows.every((row) => row.status === "cancelled")).toBe(true)

    const pendingJobs = await findPendingJobsForDeployment(deployment.id)
    expect(pendingJobs).toHaveLength(0)
  })

  test("latest-job lookups prefer a newer active job over archived history", async () => {
    const deployment = await createTestDeployment()
    const archivedJob = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })

    const capability = runnerCapability(archivedJob)
    const firstClaim = await claimJobForRunner(capability, "worker-a")
    expect(firstClaim.claimed).toBe(true)
    expect((await completeJobFromRunner(capability, { planSummary: "+1" })).success).toBe(true)

    const queuedJob = await createIacJob({ deploymentId: deployment.id, jobType: "apply" })

    const latestJob = await findLatestJobForDeployment(deployment.id)
    expect(latestJob?.id).toBe(queuedJob.id)
    expect(latestJob?.status).toBe("queued")
  })

  test("rejects a run group owned by another organization", async () => {
    const deployment = await createTestDeployment()
    const foreignOrg = await createOrg({
      name: "Foreign IaC Jobs Test Org",
      slug: `foreign-iac-jobs-test-${crypto.randomUUID().slice(0, 8)}`,
      membershipMode: "invite_only",
    })
    const foreignRunGroup = await createRunGroup({
      orgId: foreignOrg.id,
      repo: deployment.repo,
      environmentKind: deployment.environmentKind,
      environmentName: deployment.environmentName,
      ref: deployment.ref,
      headSha: deployment.headSha,
      trigger: "manual",
      status: "pending",
    })

    await expect(
      createIacJob({
        deploymentId: deployment.id,
        runGroupId: foreignRunGroup.id,
        jobType: "plan",
      }),
    ).rejects.toBeInstanceOf(ExecutionContextAssociationError)

    expect(await db.select().from(iacJobs)).toHaveLength(0)
  })

  test("does not expose a foreign run group from a malformed job row", async () => {
    const deployment = await createTestDeployment()
    const foreignOrg = await createOrg({
      name: "Malformed Foreign IaC Jobs Test Org",
      slug: `malformed-foreign-iac-jobs-${crypto.randomUUID().slice(0, 8)}`,
      membershipMode: "invite_only",
    })
    const foreignRunGroup = await createRunGroup({
      orgId: foreignOrg.id,
      repo: deployment.repo,
      environmentKind: deployment.environmentKind,
      environmentName: deployment.environmentName,
      ref: deployment.ref,
      headSha: deployment.headSha,
      trigger: "manual",
      status: "pending",
    })
    const [malformedJob] = await db
      .insert(iacJobs)
      .values({
        deploymentId: deployment.id,
        runGroupId: foreignRunGroup.id,
        jobType: "plan",
      })
      .returning()

    const context = await getJobWithContext(malformedJob.id)
    expect(context?.deployment.orgId).toBe(deployment.orgId)
    expect(context?.runGroup).toBeNull()
  })

  test("rejects a transient job without an immutable execution snapshot", async () => {
    const org = await createOrg({
      name: "Missing Snapshot Test Org",
      slug: `missing-snapshot-${crypto.randomUUID().slice(0, 8)}`,
      membershipMode: "invite_only",
    })
    const [deployment] = await db
      .insert(previews)
      .values({
        orgId: org.id,
        repo: "test-repo",
        environmentKind: "transient",
        environmentName: "pr-17",
        prNumber: 17,
        workspacePath: "infra",
        ref: "refs/heads/feature/test",
        headSha: "missing-snapshot-sha",
        status: "pending",
        stateKey: "previews/pr-17/terraform.tfstate",
        mode: "terraform",
      })
      .returning()

    await expect(
      createIacJob({
        deploymentId: deployment.id,
        jobType: "plan",
      }),
    ).rejects.toBeInstanceOf(ExecutionContextAssociationError)
  })

  test("rejects a same-org run group whose snapshot names another repository", async () => {
    const deployment = await createTestDeployment()
    const runGroup = await createRunGroup({
      orgId: deployment.orgId,
      repo: deployment.repo,
      environmentKind: deployment.environmentKind,
      environmentName: deployment.environmentName,
      ref: deployment.ref,
      headSha: deployment.headSha,
      selectedWorkspacePaths: [deployment.workspacePath],
      trigger: "manual",
      status: "pending",
      executionSnapshot: {
        version: 1,
        source: {
          installationId: 1,
          repositoryId: 2,
          ownerId: 3,
          owner: "test-owner",
          repository: "another-repo",
          defaultBranch: "main",
          ref: deployment.ref,
          commitSha: deployment.headSha,
          baseSha: null,
          actor: { githubId: null, login: null },
        },
        configuration: {
          path: "yaffle.toml",
          revision: deployment.headSha,
          digest: "mismatched-config-digest",
        },
        environment: {
          kind: "named",
          name: deployment.environmentName,
          sourcePullRequestNumber: null,
        },
        workspaces: [
          {
            path: deployment.workspacePath,
            variables: {},
            approval: { required: false, approvers: [] },
            lifecycle: { activation: [], verification: [] },
            automaticPreviewIsolation: false,
          },
        ],
      },
    })

    await expect(
      createIacJob({
        deploymentId: deployment.id,
        runGroupId: runGroup.id,
        jobType: "plan",
      }),
    ).rejects.toBeInstanceOf(ExecutionContextAssociationError)

    const [malformedJob] = await db
      .insert(iacJobs)
      .values({
        deploymentId: deployment.id,
        runGroupId: runGroup.id,
        jobType: "plan",
      })
      .returning()
    expect((await getJobWithContext(malformedJob.id))?.runGroup).toBeNull()
  })

  test("rejects approval audit records bound to another organization", async () => {
    const deployment = await createTestDeployment()
    const user = await createTestUser({ id: `approval-user-${crypto.randomUUID()}` })
    const foreignOrg = await createOrg({
      name: "Foreign Approval Test Org",
      slug: `foreign-approval-test-${crypto.randomUUID().slice(0, 8)}`,
      membershipMode: "invite_only",
    })
    const foreignRunGroup = await createRunGroup({
      orgId: foreignOrg.id,
      repo: deployment.repo,
      environmentKind: deployment.environmentKind,
      environmentName: deployment.environmentName,
      ref: deployment.ref,
      headSha: deployment.headSha,
      selectedWorkspacePaths: [deployment.workspacePath],
      trigger: "manual",
      status: "pending",
      executionSnapshot: {
        version: 1,
        source: {
          installationId: 1,
          repositoryId: 2,
          ownerId: 3,
          owner: "foreign-owner",
          repository: deployment.repo,
          defaultBranch: "main",
          ref: deployment.ref,
          commitSha: deployment.headSha,
          baseSha: null,
          actor: { githubId: null, login: null },
        },
        configuration: {
          path: "yaffle.toml",
          revision: deployment.headSha,
          digest: "foreign-config-digest",
        },
        environment: {
          kind: "named",
          name: deployment.environmentName,
          sourcePullRequestNumber: null,
        },
        workspaces: [
          {
            path: deployment.workspacePath,
            variables: {},
            approval: { required: true, approvers: [] },
            lifecycle: { activation: [], verification: [] },
            automaticPreviewIsolation: false,
          },
        ],
      },
    })

    await expect(
      createApproval({
        deploymentId: deployment.id,
        runGroupId: foreignRunGroup.id,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(ExecutionContextAssociationError)

    expect(await db.select().from(approvals)).toHaveLength(0)

    await db.insert(approvals).values({
      deploymentId: deployment.id,
      runGroupId: foreignRunGroup.id,
      userId: user.id,
    })
    expect(await listApprovals(deployment.id)).toEqual([])
  })
})
