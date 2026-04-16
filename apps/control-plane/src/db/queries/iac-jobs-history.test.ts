import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { cleanupTestData } from "../../test-utils/auth.ts"
import { iacJobHistory, iacJobs, previews } from "../schema.ts"
import { createOrg } from "./organizations.ts"
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

  const rows = await db
    .insert(previews)
    .values({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "named",
      environmentName: `main-${crypto.randomUUID().slice(0, 8)}`,
      prNumber: null,
      workspacePath: "infra",
      ref: "refs/heads/main",
      headSha: crypto.randomUUID().replaceAll("-", ""),
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
})
