import { afterEach, describe, expect, test } from "bun:test"
import { asc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { jobs } from "../schema.ts"
import { cleanupTestData } from "../../test-utils/auth.ts"
import { claimJob, createJob } from "./jobs.ts"
import { createOrg } from "./organizations.ts"

async function createTestOrg() {
  return createOrg({
    name: "Jobs Test Org",
    slug: `jobs-test-${crypto.randomUUID().slice(0, 8)}`,
    membershipMode: "invite_only",
  })
}

afterEach(async () => {
  await cleanupTestData()
})

describe("claimJob", () => {
  test("claims exactly one eligible job and leaves the rest pending", async () => {
    const org = await createTestOrg()

    const oldestJob = await createJob({
      orgId: org.id,
      jobType: "org_provision",
      payload: { order: 1 },
      runAt: new Date("2024-01-01T00:00:00Z"),
    })
    const laterJob = await createJob({
      orgId: org.id,
      jobType: "org_provision",
      payload: { order: 2 },
      runAt: new Date("2024-01-01T00:00:01Z"),
    })

    const claimed = await claimJob("worker-a", ["org_provision"])

    expect(claimed?.id).toBe(oldestJob.id)
    expect(claimed?.status).toBe("running")
    expect(claimed?.lockedBy).toBe("worker-a")
    expect(claimed?.attempts).toBe(1)

    const storedJobs = await db
      .select()
      .from(jobs)
      .where(eq(jobs.orgId, org.id))
      .orderBy(asc(jobs.runAt), asc(jobs.createdAt), asc(jobs.id))

    expect(storedJobs).toHaveLength(2)
    expect(storedJobs[0]).toMatchObject({
      id: oldestJob.id,
      status: "running",
      lockedBy: "worker-a",
      attempts: 1,
    })
    expect(storedJobs[1]).toMatchObject({
      id: laterJob.id,
      status: "pending",
      lockedBy: null,
      attempts: 0,
    })
  })

  test("returns distinct jobs on consecutive claims", async () => {
    const org = await createTestOrg()

    const firstJob = await createJob({
      orgId: org.id,
      jobType: "org_provision",
      payload: { order: 1 },
      runAt: new Date("2024-01-01T00:00:00Z"),
    })
    const secondJob = await createJob({
      orgId: org.id,
      jobType: "org_provision",
      payload: { order: 2 },
      runAt: new Date("2024-01-01T00:00:01Z"),
    })

    const firstClaim = await claimJob("worker-a", ["org_provision"])
    const secondClaim = await claimJob("worker-b", ["org_provision"])

    expect(firstClaim?.id).toBe(firstJob.id)
    expect(secondClaim?.id).toBe(secondJob.id)
    expect(firstClaim?.id).not.toBe(secondClaim?.id)
  })

  test("skips delayed and mismatched job types", async () => {
    const org = await createTestOrg()

    await createJob({
      orgId: org.id,
      jobType: "org_provision",
      payload: { kind: "future" },
      runAt: new Date("2999-01-01T00:00:00Z"),
    })
    const matchingJob = await createJob({
      orgId: org.id,
      jobType: "provider_discovery",
      payload: { kind: "matching" },
      runAt: new Date("2024-01-01T00:00:00Z"),
    })

    const claimed = await claimJob("worker-a", ["provider_discovery"])

    expect(claimed?.id).toBe(matchingJob.id)
    expect(claimed?.jobType).toBe("provider_discovery")
  })
})
