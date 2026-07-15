import { afterEach, describe, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { cleanupTestData, createTestUser } from "../../test-utils/auth.ts"
import { approvals, iacJobHistory, iacJobs, previews } from "../schema.ts"
import { createApproval, listApprovals } from "./approvals.ts"
import { createOrg } from "./organizations.ts"
import { createRunGroup } from "./run-groups.ts"
import { ExecutionContextAssociationError } from "../../lib/execution-snapshot.ts"
import {
  cancelJobsForDeployment,
  claimJobForRunner,
  completeJobFromRunner,
  createIacJob,
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

afterEach(async () => {
  await cleanupTestData()
})

describe("iac job active/history split", () => {
  test("completeJobFromRunner archives terminal jobs and keeps lookups working", async () => {
    const deployment = await createTestDeployment()
    const job = await createIacJob({ deploymentId: deployment.id, jobType: "plan" })

    const claimResult = await claimJobForRunner(job.id, "worker-a")
    expect(claimResult.claimed).toBe(true)

    const completionResult = await completeJobFromRunner(job.id, { planSummary: "+1, ~0, -0" })
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

    const claimResult = await claimJobForRunner(runningJob.id, "worker-a")
    expect(claimResult.claimed).toBe(true)

    const cancelledCount = await cancelJobsForDeployment(deployment.id)
    expect(cancelledCount).toBe(2)

    const activeRows = await db.select().from(iacJobs).where(eq(iacJobs.deploymentId, deployment.id))
    const historyRows = await db.select().from(iacJobHistory).where(eq(iacJobHistory.deploymentId, deployment.id))

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

    const firstClaim = await claimJobForRunner(archivedJob.id, "worker-a")
    expect(firstClaim.claimed).toBe(true)
    expect((await completeJobFromRunner(archivedJob.id, { planSummary: "+1" })).success).toBe(true)

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

    await expect(createIacJob({
      deploymentId: deployment.id,
      runGroupId: foreignRunGroup.id,
      jobType: "plan",
    })).rejects.toBeInstanceOf(ExecutionContextAssociationError)

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

    await expect(createIacJob({
      deploymentId: deployment.id,
      jobType: "plan",
    })).rejects.toBeInstanceOf(ExecutionContextAssociationError)
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
        workspaces: [{
          path: deployment.workspacePath,
          variables: {},
          approval: { required: false, approvers: [] },
          lifecycle: { activation: [], verification: [] },
          automaticPreviewIsolation: false,
        }],
      },
    })

    await expect(createIacJob({
      deploymentId: deployment.id,
      runGroupId: runGroup.id,
      jobType: "plan",
    })).rejects.toBeInstanceOf(ExecutionContextAssociationError)

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
        workspaces: [{
          path: deployment.workspacePath,
          variables: {},
          approval: { required: true, approvers: [] },
          lifecycle: { activation: [], verification: [] },
          automaticPreviewIsolation: false,
        }],
      },
    })

    await expect(createApproval({
      deploymentId: deployment.id,
      runGroupId: foreignRunGroup.id,
      userId: user.id,
    })).rejects.toBeInstanceOf(ExecutionContextAssociationError)

    expect(await db.select().from(approvals)).toHaveLength(0)

    await db.insert(approvals).values({
      deploymentId: deployment.id,
      runGroupId: foreignRunGroup.id,
      userId: user.id,
    })
    expect(await listApprovals(deployment.id)).toEqual([])
  })
})
