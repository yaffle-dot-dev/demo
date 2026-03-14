/**
 * Generic Background Jobs
 *
 * Simple job queue for async tasks like org provisioning.
 */

import { and, eq, inArray, lte, isNull, sql } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { jobs } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type JobStatus = "pending" | "running" | "completed" | "failed"

/**
 * Create a new job.
 */
export async function createJob(data: {
  orgId: string
  jobType: string
  payload: Record<string, unknown>
  runAt?: Date
}): Promise<Job> {
  return withDbSpan("insert", "jobs", async () => {
    const rows = await db
      .insert(jobs)
      .values({
        orgId: data.orgId,
        jobType: data.jobType,
        payload: data.payload,
        runAt: data.runAt ?? new Date(),
        status: "pending",
      })
      .returning()
    return rows[0]
  })
}

/**
 * Find a job by ID.
 */
export async function findJobById(id: string): Promise<Job | undefined> {
  return withDbSpan("select", "jobs", async () => {
    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1)
    return rows[0]
  })
}

/**
 * Claim a pending job for processing.
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent access.
 */
export async function claimJob(
  workerId: string,
  jobTypes?: string[],
): Promise<Job | undefined> {
  return withDbSpan("update", "jobs", async () => {
    // Build conditions
    const conditions = [
      eq(jobs.status, "pending"),
      lte(jobs.runAt, new Date()),
      isNull(jobs.lockedBy),
    ]

    // Optionally filter by job type
    if (jobTypes && jobTypes.length > 0) {
      // Use inArray for proper array handling
      conditions.push(inArray(jobs.jobType, jobTypes))
    }

    const rows = await db
      .update(jobs)
      .set({
        status: "running",
        lockedBy: workerId,
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(and(...conditions))
      .returning()

    return rows[0]
  })
}

/**
 * Complete a job successfully.
 */
export async function completeJob(jobId: string): Promise<void> {
  return withDbSpan("update", "jobs", async () => {
    await db
      .update(jobs)
      .set({ status: "completed" })
      .where(eq(jobs.id, jobId))
  })
}

/**
 * Fail a job.
 */
export async function failJob(jobId: string): Promise<void> {
  return withDbSpan("update", "jobs", async () => {
    await db
      .update(jobs)
      .set({
        status: "failed",
        lockedBy: null,
      })
      .where(eq(jobs.id, jobId))
  })
}

/**
 * Release a job back to pending (for retry).
 */
export async function releaseJob(jobId: string, runAt?: Date): Promise<void> {
  return withDbSpan("update", "jobs", async () => {
    await db
      .update(jobs)
      .set({
        status: "pending",
        lockedBy: null,
        runAt: runAt ?? new Date(),
      })
      .where(eq(jobs.id, jobId))
  })
}

/**
 * Find pending jobs for an org by type.
 */
export async function findPendingJobsByType(
  orgId: string,
  jobType: string,
): Promise<Job[]> {
  return withDbSpan("select", "jobs", async () => {
    return db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.orgId, orgId),
          eq(jobs.jobType, jobType),
          eq(jobs.status, "pending"),
        ),
      )
  })
}
