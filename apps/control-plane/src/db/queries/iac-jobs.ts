import { and, eq, inArray, sql } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { iacJobs, workspaceDeployments } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { events } from "../../lib/events.ts"

export type IacJob = typeof iacJobs.$inferSelect
export type NewIacJob = typeof iacJobs.$inferInsert
export type IacJobType = "plan" | "apply" | "destroy"
export type IacJobStatus = "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled"

/**
 * Create a new IaC job in the queue.
 */
export async function createIacJob(values: {
  /** @deprecated Use deploymentId */
  previewId?: string
  deploymentId?: string
  jobType: IacJobType
}): Promise<IacJob> {
  const deploymentId = values.deploymentId ?? values.previewId
  if (!deploymentId) {
    throw new Error("Either deploymentId or previewId is required")
  }

  return withDbSpan("insert", "iac_jobs", async () => {
    const rows = await db
      .insert(iacJobs)
      .values({
        deploymentId,
        jobType: values.jobType,
        status: "queued",
      })
      .returning()

    const job = rows[0]
    events.emitJobUpdate(job.id, job.deploymentId)
    return job
  })
}

/**
 * Find a job by ID.
 */
export async function findIacJobById(id: string): Promise<IacJob | undefined> {
  return withDbSpan("select", "iac_jobs", async () => {
    const rows = await db
      .select()
      .from(iacJobs)
      .where(eq(iacJobs.id, id))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find the latest job for a deployment by type.
 */
export async function findLatestIacJob(
  deploymentId: string,
  jobType: IacJobType,
): Promise<IacJob | undefined> {
  return withDbSpan("select", "iac_jobs", async () => {
    const rows = await db
      .select()
      .from(iacJobs)
      .where(and(eq(iacJobs.deploymentId, deploymentId), eq(iacJobs.jobType, jobType)))
      .orderBy(sql`${iacJobs.queuedAt} DESC`)
      .limit(1)
    return rows[0]
  })
}

/**
 * Claim queued jobs for dispatch.
 * Uses FOR UPDATE SKIP LOCKED to safely claim jobs in a distributed environment.
 *
 * @param limit - Maximum number of jobs to claim
 * @param workerId - Unique identifier for this worker/scheduler instance
 * @returns Array of claimed jobs
 */
export async function claimQueuedJobs(
  limit: number,
  workerId: string,
): Promise<IacJob[]> {
  return withDbSpan("update", "iac_jobs", async () => {
    // Use a transaction with FOR UPDATE SKIP LOCKED
    return db.transaction(async (tx) => {
      // Find queued jobs, skipping any that are locked by other transactions
      const queuedJobs = await tx
        .select({ id: iacJobs.id })
        .from(iacJobs)
        .where(eq(iacJobs.status, "queued"))
        .orderBy(iacJobs.queuedAt)
        .limit(limit)
        .for("update", { skipLocked: true })

      if (queuedJobs.length === 0) {
        return []
      }

      const jobIds = queuedJobs.map((j) => j.id)

      // Mark them as dispatched
      const dispatched = await tx
        .update(iacJobs)
        .set({
          status: "dispatched",
          workerId,
          dispatchedAt: new Date(),
        })
        .where(inArray(iacJobs.id, jobIds))
        .returning()

      return dispatched
    })
  })
}

/**
 * Mark a job as running (called by IaC engine when it starts).
 * 
 * Only transitions from "dispatched" state to prevent marking already
 * completed/failed jobs as running.
 */
export async function markJobRunning(
  jobId: string,
  workerId: string,
): Promise<IacJob | undefined> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        status: "running",
        workerId,
        startedAt: new Date(),
        lastHeartbeat: new Date(),
        attempts: sql`${iacJobs.attempts} + 1`,
      })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "dispatched"),
        ),
      )
      .returning()

    const job = rows[0]
    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)
    }
    return job
  })
}

/**
 * Update job heartbeat (called periodically by IaC engine).
 */
export async function updateJobHeartbeat(jobId: string): Promise<void> {
  return withDbSpan("update", "iac_jobs", async () => {
    await db
      .update(iacJobs)
      .set({ lastHeartbeat: new Date() })
      .where(eq(iacJobs.id, jobId))
  })
}

/**
 * Mark a job as completed with result.
 */
export async function completeJob(
  jobId: string,
  result: Record<string, unknown>,
): Promise<IacJob | undefined> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        result,
      })
      .where(eq(iacJobs.id, jobId))
      .returning()

    const job = rows[0]
    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)
    }
    return job
  })
}

/**
 * Mark a job as failed with error message.
 */
export async function failJob(
  jobId: string,
  errorMessage: string,
): Promise<IacJob | undefined> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage,
      })
      .where(eq(iacJobs.id, jobId))
      .returning()

    const job = rows[0]
    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)
    }
    return job
  })
}

/**
 * Find stale jobs that have been running/dispatched without a heartbeat.
 * These are jobs where the worker likely died.
 *
 * @param staleThresholdMs - How long without heartbeat before considered stale (default 5 min)
 */
export async function findStaleJobs(
  staleThresholdMs: number = 5 * 60 * 1000,
): Promise<IacJob[]> {
  return withDbSpan("select", "iac_jobs", async () => {
    const threshold = new Date(Date.now() - staleThresholdMs).toISOString()

    return db
      .select()
      .from(iacJobs)
      .where(
        and(
          inArray(iacJobs.status, ["dispatched", "running"]),
          // Either never had a heartbeat, or heartbeat is stale
          sql`(${iacJobs.lastHeartbeat} IS NULL AND ${iacJobs.dispatchedAt} < ${threshold}::timestamptz)
              OR (${iacJobs.lastHeartbeat} < ${threshold}::timestamptz)`,
        ),
      )
  })
}

/**
 * Re-queue a stale job for retry, or mark as failed if max attempts reached.
 * 
 * Uses FOR UPDATE to prevent TOCTOU race conditions where a "stale" worker
 * wakes up between our check and update.
 */
export async function requeueOrFailStaleJob(
  jobId: string,
): Promise<{ requeued: boolean; failed: boolean }> {
  return withDbSpan("update", "iac_jobs", async () => {
    // Use a transaction with FOR UPDATE to lock the row and prevent races
    return db.transaction(async (tx) => {
      // Lock the job row while we check and update
      const jobs = await tx
        .select()
        .from(iacJobs)
        .where(eq(iacJobs.id, jobId))
        .for("update")
        .limit(1)

      const job = jobs[0]
      if (!job) {
        return { requeued: false, failed: false }
      }

      // Double-check it's still stale (worker might have heartbeated while we waited for lock)
      const isStillStale = !job.lastHeartbeat ||
        (Date.now() - job.lastHeartbeat.getTime()) > 5 * 60 * 1000

      if (!isStillStale) {
        // Job is no longer stale - worker is alive
        return { requeued: false, failed: false }
      }

      if (job.attempts >= job.maxAttempts) {
        // Max retries reached, mark as failed
        await tx
          .update(iacJobs)
          .set({
            status: "failed",
            completedAt: new Date(),
            errorMessage: `Job timed out after ${job.attempts} attempts (worker died or timed out)`,
          })
          .where(eq(iacJobs.id, jobId))

        events.emitJobUpdate(job.id, job.deploymentId)
        return { requeued: false, failed: true }
      }

      // Re-queue for another attempt
      await tx
        .update(iacJobs)
        .set({
          status: "queued",
          workerId: null,
          dispatchedAt: null,
          startedAt: null,
          lastHeartbeat: null,
        })
        .where(eq(iacJobs.id, jobId))

      events.emitJobUpdate(job.id, job.deploymentId)
      return { requeued: true, failed: false }
    })
  })
}

/**
 * Get job with deployment context (for IaC engine to execute).
 */
export async function getJobWithContext(jobId: string): Promise<
  | (IacJob & {
      deployment: {
        id: string
        orgId: string
        repo: string
        environmentKind: string
        environmentName: string
        prNumber: number | null
        workspacePath: string
        ref: string
        headSha: string
        stateKey: string
        installationId: number | null
        runGroupId: string | null
      }
      /** @deprecated Use deployment */
      preview: {
        id: string
        orgId: string
        repo: string
        prNumber: number | null
        workspacePath: string
        ref: string
        headSha: string
        stateKey: string
        installationId: number | null
        runGroupId: string | null
      }
    })
  | undefined
> {
  return withDbSpan("select", "iac_jobs", async () => {
    const rows = await db
      .select({
        job: iacJobs,
        deployment: {
          id: workspaceDeployments.id,
          orgId: workspaceDeployments.orgId,
          repo: workspaceDeployments.repo,
          environmentKind: workspaceDeployments.environmentKind,
          environmentName: workspaceDeployments.environmentName,
          prNumber: workspaceDeployments.prNumber,
          workspacePath: workspaceDeployments.workspacePath,
          ref: workspaceDeployments.ref,
          headSha: workspaceDeployments.headSha,
          stateKey: workspaceDeployments.stateKey,
          installationId: workspaceDeployments.installationId,
          runGroupId: workspaceDeployments.runGroupId,
        },
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .where(eq(iacJobs.id, jobId))
      .limit(1)

    if (rows.length === 0) return undefined

    const { job, deployment } = rows[0]
    // Provide backward-compatible preview alias
    return { ...job, deployment, preview: deployment }
  })
}

/**
 * Find all pending/queued jobs for a deployment.
 * Used to check if work is already queued before creating duplicates.
 */
export async function findPendingJobsForDeployment(
  deploymentId: string,
  jobType?: IacJobType,
): Promise<IacJob[]> {
  return withDbSpan("select", "iac_jobs", async () => {
    const conditions = [
      eq(iacJobs.deploymentId, deploymentId),
      inArray(iacJobs.status, ["queued", "dispatched", "running"]),
    ]

    if (jobType) {
      conditions.push(eq(iacJobs.jobType, jobType))
    }

    return db.select().from(iacJobs).where(and(...conditions))
  })
}

// Alias for backward compatibility
export const findPendingJobsForPreview = findPendingJobsForDeployment

/**
 * Cancel all pending jobs for a deployment.
 * Called when a PR is closed to stop any queued/running work.
 *
 * @returns Number of jobs cancelled
 */
export async function cancelJobsForDeployment(deploymentId: string): Promise<number> {
  return withDbSpan("update", "iac_jobs", async () => {
    const result = await db
      .update(iacJobs)
      .set({
        status: "cancelled",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(iacJobs.deploymentId, deploymentId),
          inArray(iacJobs.status, ["queued", "dispatched", "running"]),
        ),
      )
      .returning({ id: iacJobs.id })

    // Emit updates for each cancelled job
    for (const job of result) {
      events.emitJobUpdate(job.id, deploymentId)
    }

    return result.length
  })
}

// Alias for backward compatibility
export const cancelJobsForPreview = cancelJobsForDeployment

// =============================================================================
// Concurrency Control
// =============================================================================

/**
 * Count currently active jobs (dispatched or running).
 * Used to enforce global concurrency limits.
 */
export async function countActiveJobs(): Promise<number> {
  return withDbSpan("select", "iac_jobs", async () => {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(iacJobs)
      .where(inArray(iacJobs.status, ["dispatched", "running"]))

    return result[0]?.count ?? 0
  })
}

/**
 * Count active jobs per run group.
 * Returns a map of runGroupId -> active job count.
 */
export async function countActiveJobsByRunGroup(): Promise<Map<string, number>> {
  return withDbSpan("select", "iac_jobs", async () => {
    const result = await db
      .select({
        runGroupId: workspaceDeployments.runGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .where(inArray(iacJobs.status, ["dispatched", "running"]))
      .groupBy(workspaceDeployments.runGroupId)

    const map = new Map<string, number>()
    for (const row of result) {
      if (row.runGroupId) {
        map.set(row.runGroupId, row.count)
      }
    }
    return map
  })
}

/**
 * Get queued jobs grouped by run group, ordered by queue time.
 * Used for fair round-robin scheduling across run groups.
 */
export async function getQueuedJobsByRunGroup(): Promise<Map<string, IacJob[]>> {
  return withDbSpan("select", "iac_jobs", async () => {
    const jobs = await db
      .select({
        job: iacJobs,
        runGroupId: workspaceDeployments.runGroupId,
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .where(eq(iacJobs.status, "queued"))
      .orderBy(iacJobs.queuedAt)

    const map = new Map<string, IacJob[]>()
    for (const { job, runGroupId } of jobs) {
      const key = runGroupId ?? "no-group"
      if (!map.has(key)) {
        map.set(key, [])
      }
      map.get(key)!.push(job)
    }
    return map
  })
}

export interface ConcurrencyLimits {
  /** Maximum total concurrent jobs across all run groups */
  maxTotal: number
  /** Maximum concurrent jobs per run group */
  maxPerRunGroup: number
}

export interface ClaimResult {
  /** Jobs that were claimed */
  claimed: IacJob[]
  /** Number of jobs that couldn't be claimed due to global limit */
  blockedByGlobalLimit: number
  /** Number of jobs that couldn't be claimed due to per-group limit */
  blockedByGroupLimit: number
  /** Total queued jobs across all groups */
  totalQueued: number
  /** Number of run groups with queued work */
  groupsWithQueuedWork: number
  /** Number of group queries executed */
  groupsQueried: number
  /** Total jobs fetched across all queries */
  jobsFetched: number
  /** Jobs skipped due to SKIP LOCKED (contention indicator) */
  skipLockedMisses: number
}

/**
 * SQL CASE expression for job type priority ordering.
 * apply (0) > destroy (1) > plan (2)
 */
const JOB_TYPE_PRIORITY_SQL = sql<number>`
  CASE ${iacJobs.jobType}
    WHEN 'apply' THEN 0
    WHEN 'destroy' THEN 1
    WHEN 'plan' THEN 2
    ELSE 3
  END
`

/**
 * Claim queued jobs respecting concurrency limits with round-robin fairness.
 *
 * Algorithm:
 * 1. Count active jobs globally - if at limit, return early
 * 2. Get list of run_group_ids with queued work
 * 3. Count active jobs per group
 * 4. For each group with available capacity, fetch top N jobs ordered by priority
 *    using FOR UPDATE SKIP LOCKED (priority ordering happens in PostgreSQL)
 * 5. Round-robin interleave results from all groups
 * 6. Jobs are already locked from step 4, just mark as dispatched
 *
 * This approach:
 * - Fixes priority inversion bug (DB orders by priority before SKIP LOCKED)
 * - Limits memory usage (only fetch maxPerGroup jobs per group)
 * - Reduces lock contention (smaller row sets locked per group)
 */
export async function claimQueuedJobsWithLimits(
  limits: ConcurrencyLimits,
  workerId: string,
): Promise<ClaimResult> {
  return withDbSpan("update", "iac_jobs", async () => {
    return db.transaction(async (tx) => {
      // 1. Count current active jobs
      const activeCountResult = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(iacJobs)
        .where(inArray(iacJobs.status, ["dispatched", "running"]))

      const activeTotal = activeCountResult[0]?.count ?? 0
      let availableSlots = Math.max(0, limits.maxTotal - activeTotal)

      if (availableSlots === 0) {
        // At global limit - count queued for metrics
        const queuedResult = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(iacJobs)
          .where(eq(iacJobs.status, "queued"))

        return {
          claimed: [],
          blockedByGlobalLimit: queuedResult[0]?.count ?? 0,
          blockedByGroupLimit: 0,
          totalQueued: queuedResult[0]?.count ?? 0,
          groupsWithQueuedWork: 0,
          groupsQueried: 0,
          jobsFetched: 0,
          skipLockedMisses: 0,
        }
      }

      // 2. Get run groups with queued work and their queue counts
      const groupsWithWork = await tx
        .select({
          runGroupId: workspaceDeployments.runGroupId,
          queuedCount: sql<number>`count(*)::int`,
        })
        .from(iacJobs)
        .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
        .where(eq(iacJobs.status, "queued"))
        .groupBy(workspaceDeployments.runGroupId)

      if (groupsWithWork.length === 0) {
        return {
          claimed: [],
          blockedByGlobalLimit: 0,
          blockedByGroupLimit: 0,
          totalQueued: 0,
          groupsWithQueuedWork: 0,
          groupsQueried: 0,
          jobsFetched: 0,
          skipLockedMisses: 0,
        }
      }

      const totalQueued = groupsWithWork.reduce((sum, g) => sum + g.queuedCount, 0)
      const groupsWithQueuedWork = groupsWithWork.length

      // 3. Count active jobs per run group
      const activeByGroupResult = await tx
        .select({
          runGroupId: workspaceDeployments.runGroupId,
          count: sql<number>`count(*)::int`,
        })
        .from(iacJobs)
        .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
        .where(inArray(iacJobs.status, ["dispatched", "running"]))
        .groupBy(workspaceDeployments.runGroupId)

      const activeByGroup = new Map<string, number>()
      for (const row of activeByGroupResult) {
        activeByGroup.set(row.runGroupId ?? "no-group", row.count)
      }

      // 4. For each group, fetch top N jobs ordered by priority
      // Query groups sequentially to reduce connection pressure
      const jobsByGroup = new Map<string, IacJob[]>()
      let groupsQueried = 0
      let totalJobsFetched = 0
      let skipLockedMisses = 0
      let blockedByGroupLimit = 0

      for (const { runGroupId, queuedCount } of groupsWithWork) {
        const groupKey = runGroupId ?? "no-group"
        const currentActive = activeByGroup.get(groupKey) ?? 0
        const groupCapacity = Math.max(0, limits.maxPerRunGroup - currentActive)

        if (groupCapacity === 0) {
          // Group is at capacity
          blockedByGroupLimit += queuedCount
          continue
        }

        // Fetch top N jobs for this group, ordered by priority (in DB!)
        groupsQueried++
        const groupJobs = await tx
          .select()
          .from(iacJobs)
          .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
          .where(
            and(
              eq(iacJobs.status, "queued"),
              runGroupId
                ? eq(workspaceDeployments.runGroupId, runGroupId)
                : sql`${workspaceDeployments.runGroupId} IS NULL`,
            ),
          )
          .orderBy(JOB_TYPE_PRIORITY_SQL, iacJobs.queuedAt)
          .limit(groupCapacity)
          .for("update", { skipLocked: true })

        // Extract just the iac_jobs part (the join returns both tables)
        const jobs: IacJob[] = groupJobs.map((row) => row.iac_jobs)
        totalJobsFetched += jobs.length

        // Track SKIP LOCKED misses: we asked for groupCapacity but got fewer
        // This indicates contention (another scheduler locked some rows)
        const expectedJobs = Math.min(groupCapacity, queuedCount)
        if (jobs.length < expectedJobs) {
          skipLockedMisses += expectedJobs - jobs.length
        }

        if (jobs.length > 0) {
          jobsByGroup.set(groupKey, jobs)
        }

        // Track remaining jobs as blocked by group limit
        if (queuedCount > groupCapacity) {
          blockedByGroupLimit += queuedCount - groupCapacity
        }
      }

      if (jobsByGroup.size === 0) {
        return {
          claimed: [],
          blockedByGlobalLimit: 0,
          blockedByGroupLimit,
          totalQueued,
          groupsWithQueuedWork,
          groupsQueried,
          jobsFetched: totalJobsFetched,
          skipLockedMisses,
        }
      }

      // 5. Round-robin interleave jobs from all groups
      const toClaim: string[] = []
      let blockedByGlobalLimit = 0

      const groupIds = Array.from(jobsByGroup.keys())
      const groupIndices = new Map<string, number>()
      for (const gid of groupIds) {
        groupIndices.set(gid, 0)
      }

      let madeProgress = true
      while (madeProgress && toClaim.length < availableSlots) {
        madeProgress = false

        for (const groupId of groupIds) {
          if (toClaim.length >= availableSlots) {
            // Count remaining fetched jobs as blocked by global limit
            for (const gid of groupIds) {
              const jobs = jobsByGroup.get(gid)!
              const idx = groupIndices.get(gid)!
              blockedByGlobalLimit += jobs.length - idx
            }
            break
          }

          const jobs = jobsByGroup.get(groupId)!
          const idx = groupIndices.get(groupId)!

          if (idx >= jobs.length) {
            continue // No more jobs fetched for this group
          }

          // Claim this job
          toClaim.push(jobs[idx].id)
          groupIndices.set(groupId, idx + 1)
          madeProgress = true
        }
      }

      if (toClaim.length === 0) {
        return {
          claimed: [],
          blockedByGlobalLimit,
          blockedByGroupLimit,
          totalQueued,
          groupsWithQueuedWork,
          groupsQueried,
          jobsFetched: totalJobsFetched,
          skipLockedMisses,
        }
      }

      // 6. Mark claimed jobs as dispatched
      // Jobs are already locked from step 4, so this is safe
      const claimed = await tx
        .update(iacJobs)
        .set({
          status: "dispatched",
          workerId,
          dispatchedAt: new Date(),
        })
        .where(inArray(iacJobs.id, toClaim))
        .returning()

      return {
        claimed,
        blockedByGlobalLimit,
        blockedByGroupLimit,
        totalQueued,
        groupsWithQueuedWork,
        groupsQueried,
        jobsFetched: totalJobsFetched,
        skipLockedMisses,
      }
    })
  })
}
