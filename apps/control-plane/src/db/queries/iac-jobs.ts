import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { iacJobs, iacJobStatusEnum, iacJobTypeEnum, tfRuns, workspaceDeployments } from "../schema.ts"
import {
  withDbSpan,
  logger,
  getJobQueueWaitHistogram,
  getJobRunDurationHistogram,
  getJobHeartbeatsCounter,
  getJobStateTransitionsCounter,
} from "../../lib/telemetry.ts"
import { events } from "../../lib/events.ts"
import { updateDeploymentStatus } from "./workspace-deployments.ts"
import { updateRunStatus } from "./tf-runs.ts"
import { cascadeFailure } from "../../lib/deployment-side-effects.ts"

export type IacJob = typeof iacJobs.$inferSelect
export type NewIacJob = typeof iacJobs.$inferInsert
// Infer types from the enum definitions for compile-time safety
export type IacJobType = (typeof iacJobTypeEnum.enumValues)[number]
export type IacJobStatus = (typeof iacJobStatusEnum.enumValues)[number]

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
        blockedAt: null,
        blockedReason: null,
      })
      .returning()

    const job = rows[0]
    events.emitJobUpdate(job.id, job.deploymentId)

    // Record state transition metric
    getJobStateTransitionsCounter().add(1, {
      from_state: "none",
      to_state: "queued",
      job_type: job.jobType,
    })

    // Lifecycle log: job created
    logger.info("job.created", {
      "job.id": job.id,
      "job.type": job.jobType,
      "job.status": "queued",
      "deployment.id": job.deploymentId,
    })

    return job
  })
}

export async function markJobBlocked(
  jobId: string,
  reason: string,
): Promise<void> {
  return withDbSpan("update", "iac_jobs", async () => {
    await db
      .update(iacJobs)
      .set({
        blockedAt: new Date(),
        blockedReason: reason,
      })
      .where(and(eq(iacJobs.id, jobId), eq(iacJobs.status, "queued")))
  })
}

export async function clearJobBlocked(jobId: string): Promise<void> {
  return withDbSpan("update", "iac_jobs", async () => {
    await db
      .update(iacJobs)
      .set({
        blockedAt: null,
        blockedReason: null,
      })
      .where(eq(iacJobs.id, jobId))
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

export async function findLatestJobForDeployment(
  deploymentId: string,
): Promise<IacJob | undefined> {
  return withDbSpan("select", "iac_jobs", async () => {
    const rows = await db
      .select()
      .from(iacJobs)
      .where(eq(iacJobs.deploymentId, deploymentId))
      .orderBy(sql`${iacJobs.queuedAt} DESC`)
      .limit(1)
    return rows[0]
  })
}

export async function cancelRunningJobForDeploymentAndType(
  deploymentId: string,
  jobType: IacJobType,
): Promise<IacJob | undefined> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        status: "cancelled",
        completedAt: new Date(),
      })
      .where(and(
        eq(iacJobs.deploymentId, deploymentId),
        eq(iacJobs.jobType, jobType),
        eq(iacJobs.status, "running"),
      ))
      .returning()

    const job = rows[0]
    if (!job) {
      return undefined
    }

    events.emitJobUpdate(job.id, deploymentId)
    getJobStateTransitionsCounter().add(1, {
      from_state: "running",
      to_state: "cancelled",
      job_type: job.jobType,
    })

    logger.info("job.cancelled", {
      "job.id": job.id,
      "job.type": job.jobType,
      "job.status": "cancelled",
      "job.status.previous": "running",
      "deployment.id": deploymentId,
      "worker.id": job.workerId ?? "unknown",
    })

    return job
  })
}

/**
 * Update job with ECS task ARN for tracking.
 * Used when spawning an ECS runner task.
 *
 * @deprecated In the new runner architecture, ECS workers claim jobs via API.
 * This is kept for backward compatibility during migration.
 */
export async function updateJobEcsTask(
  jobId: string,
  taskArn: string,
): Promise<void> {
  return withDbSpan("update", "iac_jobs", async () => {
    await db
      .update(iacJobs)
      .set({
        // Store task ARN in workerId field
        // For ECS jobs, this uniquely identifies the running task
        workerId: taskArn,
      })
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
 * Find stale jobs that have been running without a heartbeat.
 * These are jobs where the worker likely died.
 *
 * In the new architecture, jobs go directly from "queued" to "running" when
 * claimed by a worker. There is no more "dispatched" state.
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
          eq(iacJobs.status, "running"),
          // Either never had a heartbeat, or heartbeat is stale
          // Note: extra parens needed to ensure OR doesn't escape the AND
          sql`((${iacJobs.lastHeartbeat} IS NULL AND ${iacJobs.startedAt} < ${threshold}::timestamptz)
              OR (${iacJobs.lastHeartbeat} < ${threshold}::timestamptz))`,
        ),
      )
  })
}

/**
 * Mark a stale job as system_error.
 * 
 * System errors are distinct from user-caused failures (bad terraform config).
 * They represent Yaffle infrastructure issues (worker crash, stale timeout, etc.)
 * and may be automatically retried.
 * 
 * We intentionally do NOT auto-requeue stale jobs because:
 * 1. Terraform operations can legitimately take 10+ minutes without heartbeats
 * 2. Auto-requeuing can cause duplicate runs and state lock conflicts
 * 3. If a job is truly stuck, it's safer to fail and let humans investigate
 * 
 * Users can manually retry failed jobs via the UI "Run Again" button.
 */
export async function failStaleJob(
  jobId: string,
): Promise<{ failed: boolean }> {
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
        return { failed: false }
      }

      // Only fail jobs that are still running - skip if already completed/failed
      if (job.status !== "running") {
        return { failed: false }
      }

      // Double-check it's still stale (worker might have heartbeated while we waited for lock)
      const isStillStale = !job.lastHeartbeat ||
        (Date.now() - job.lastHeartbeat.getTime()) > 5 * 60 * 1000

      if (!isStillStale) {
        // Job is no longer stale - worker is alive
        return { failed: false }
      }

      // Mark as system_error - distinct from user-caused failures
      const completedAt = new Date()
      await tx
        .update(iacJobs)
        .set({
          status: "system_error",
          completedAt,
          errorMessage: "Job timed out (worker stopped sending heartbeats). Use 'Run Again' to retry.",
        })
        .where(eq(iacJobs.id, jobId))

      events.emitJobUpdate(job.id, job.deploymentId)

      // Calculate how long since last heartbeat
      const staleDurationMs = job.lastHeartbeat
        ? completedAt.getTime() - job.lastHeartbeat.getTime()
        : job.startedAt
          ? completedAt.getTime() - job.startedAt.getTime()
          : 0

      // Record metrics
      getJobStateTransitionsCounter().add(1, {
        from_state: job.status,
        to_state: "system_error",
        job_type: job.jobType,
        reason: "stale_timeout",
      })

      // Lifecycle log: job failed due to stale heartbeat
      logger.error("job.stale_timeout", {
        "job.id": job.id,
        "job.type": job.jobType,
        "job.status": "system_error",
        "job.status.previous": job.status,
        "deployment.id": job.deploymentId,
        "worker.id": job.workerId ?? "unknown",
        "duration.stale_ms": staleDurationMs,
        "job.last_heartbeat": job.lastHeartbeat?.toISOString() ?? "never",
      })

      return { failed: true }
    })
  }).then(async (result) => {
    // Update deployment status outside the transaction to avoid circular import issues
    if (result.failed) {
      const job = await db
        .select({ deploymentId: iacJobs.deploymentId })
        .from(iacJobs)
        .where(eq(iacJobs.id, jobId))
        .limit(1)
      if (job[0]) {
        const errorMessage = "Job timed out (worker stopped sending heartbeats). Use 'Run Again' to retry."

        const latestRunningRun = await db
          .select({ id: tfRuns.id })
          .from(tfRuns)
          .where(
            and(
              eq(tfRuns.deploymentId, job[0].deploymentId),
              eq(tfRuns.status, "running"),
            ),
          )
          .orderBy(desc(tfRuns.createdAt))
          .limit(1)

        if (latestRunningRun[0]) {
          await updateRunStatus(latestRunningRun[0].id, job[0].deploymentId, "failed", {
            completedAt: new Date(),
            errorMessage,
          })
        }

        await updateDeploymentStatus(job[0].deploymentId, "system_error")
        await cascadeFailure(job[0].deploymentId)
      }
    }
    return result
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
      inArray(iacJobs.status, ["queued", "running"]),
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
          inArray(iacJobs.status, ["queued", "running"]),
        ),
      )
      .returning({ id: iacJobs.id, jobType: iacJobs.jobType, status: iacJobs.status })

    // Emit updates and log for each cancelled job
    for (const job of result) {
      events.emitJobUpdate(job.id, deploymentId)

      // Record state transition metric
      getJobStateTransitionsCounter().add(1, {
        from_state: job.status,
        to_state: "cancelled",
        job_type: job.jobType,
      })

      // Lifecycle log: job cancelled
      logger.info("job.cancelled", {
        "job.id": job.id,
        "job.type": job.jobType,
        "job.status": "cancelled",
        "deployment.id": deploymentId,
      })
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
 * Count currently active jobs (running).
 * Used to enforce global concurrency limits.
 */
export async function countActiveJobs(): Promise<number> {
  return withDbSpan("select", "iac_jobs", async () => {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(iacJobs)
      .where(eq(iacJobs.status, "running"))

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
      .where(eq(iacJobs.status, "running"))
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

// =============================================================================
// Runner API Functions (for external worker processes)
// =============================================================================

/**
 * Atomically claim a job for a runner.
 * Transitions from "queued" to "running" state.
 *
 * This is the new pattern where workers claim jobs themselves (via API),
 * rather than the scheduler marking them as dispatched.
 *
 * @returns { claimed: true, job } if successful, { claimed: false } if already claimed
 */
export async function claimJobForRunner(
  jobId: string,
  workerId: string,
): Promise<{ claimed: boolean; job?: IacJob; queueWaitMs?: number }> {
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
          eq(iacJobs.status, "queued"), // Only claim if still queued
        ),
      )
      .returning()

    const job = rows[0]
    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)

      // Calculate queue wait time
      const queueWaitMs = job.startedAt && job.queuedAt
        ? job.startedAt.getTime() - job.queuedAt.getTime()
        : 0

      // Record metrics
      getJobQueueWaitHistogram().record(queueWaitMs, { job_type: job.jobType })
      getJobStateTransitionsCounter().add(1, {
        from_state: "queued",
        to_state: "running",
        job_type: job.jobType,
      })

      // Lifecycle log: job claimed (queued -> running)
      logger.info("job.claimed", {
        "job.id": job.id,
        "job.type": job.jobType,
        "job.status": "running",
        "job.status.previous": "queued",
        "deployment.id": job.deploymentId,
        "worker.id": workerId,
        "duration.queue_wait_ms": queueWaitMs,
        "job.attempts": job.attempts,
      })

      return { claimed: true, job, queueWaitMs }
    }
    return { claimed: false }
  })
}

/**
 * Update heartbeat for a running job.
 * Only succeeds if job is still in "running" state.
 *
 * @returns { success: true } if heartbeat updated, { success: false } if job not running
 */
export async function heartbeatJob(jobId: string): Promise<{ success: boolean }> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({ lastHeartbeat: new Date() })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "running"),
        ),
      )
      .returning({ id: iacJobs.id })

    if (rows.length > 0) {
      // Record heartbeat metric (success only)
      getJobHeartbeatsCounter().add(1)
    }

    return { success: rows.length > 0 }
  })
}

/**
 * Complete a job from runner with result.
 * Only succeeds if job is still in "running" state.
 *
 * @returns { success: true } if completed, { success: false } if job not running
 */
export async function completeJobFromRunner(
  jobId: string,
  result: Record<string, unknown>,
): Promise<{ success: boolean; job?: IacJob; runDurationMs?: number }> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        result,
      })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "running"),
        ),
      )
      .returning()

    const job = rows[0]
    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)

      // Calculate run duration
      const runDurationMs = job.completedAt && job.startedAt
        ? job.completedAt.getTime() - job.startedAt.getTime()
        : 0

      // Record metrics
      getJobRunDurationHistogram().record(runDurationMs, {
        job_type: job.jobType,
        status: "completed",
      })
      getJobStateTransitionsCounter().add(1, {
        from_state: "running",
        to_state: "completed",
        job_type: job.jobType,
      })

      // Lifecycle log: job completed (running -> completed)
      logger.info("job.completed", {
        "job.id": job.id,
        "job.type": job.jobType,
        "job.status": "completed",
        "job.status.previous": "running",
        "deployment.id": job.deploymentId,
        "worker.id": job.workerId ?? "unknown",
        "duration.run_ms": runDurationMs,
      })

      return { success: true, job, runDurationMs }
    }
    return { success: false }
  })
}

/**
 * Fail a job from runner with error message.
 * Only succeeds if job is still in "running" state.
 *
 * @returns { success: true } if failed, { success: false } if job not running
 */
export async function failJobFromRunner(
  jobId: string,
  errorMessage: string,
): Promise<{ success: boolean; job?: IacJob; runDurationMs?: number }> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage,
      })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "running"),
        ),
      )
      .returning()

    const job = rows[0]
    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)

      // Calculate run duration
      const runDurationMs = job.completedAt && job.startedAt
        ? job.completedAt.getTime() - job.startedAt.getTime()
        : 0

      // Record metrics
      getJobRunDurationHistogram().record(runDurationMs, {
        job_type: job.jobType,
        status: "failed",
      })
      getJobStateTransitionsCounter().add(1, {
        from_state: "running",
        to_state: "failed",
        job_type: job.jobType,
      })

      // Lifecycle log: job failed (running -> failed)
      logger.error("job.failed", {
        "job.id": job.id,
        "job.type": job.jobType,
        "job.status": "failed",
        "job.status.previous": "running",
        "deployment.id": job.deploymentId,
        "worker.id": job.workerId ?? "unknown",
        "duration.run_ms": runDurationMs,
        "error.message": errorMessage,
      })

      return { success: true, job, runDurationMs }
    }
    return { success: false }
  })
}

// =============================================================================
// New Spawner Functions (for resilient job execution)
// =============================================================================

export interface ConcurrencyLimits {
  /** Maximum total concurrent jobs across all run groups */
  maxTotal: number
  /** Maximum concurrent jobs per run group */
  maxPerRunGroup: number
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

export interface SpawnResult {
  /** Jobs selected for spawning */
  jobs: IacJob[]
  /** Number of jobs that couldn't be spawned due to global limit */
  blockedByGlobalLimit: number
  /** Number of jobs that couldn't be spawned due to per-group limit */
  blockedByGroupLimit: number
  /** Total queued jobs across all groups */
  totalQueued: number
  /** Number of run groups with queued work */
  groupsWithQueuedWork: number
}

/**
 * Find queued jobs ready for spawning, respecting concurrency limits.
 *
 * Jobs stay "queued" until workers claim them via API (claimJobForRunner).
 * Returns job IDs for spawning workers.
 *
 * Algorithm:
 * 1. Count active jobs (running) globally - if at limit, return early
 * 2. Get list of run_group_ids with queued work
 * 3. Count active jobs per group
 * 4. For each group with capacity, select top N jobs ordered by priority
 * 5. Round-robin interleave results from all groups
 */
export async function findQueuedJobsForSpawning(
  limits: ConcurrencyLimits,
): Promise<SpawnResult> {
  return withDbSpan("select", "iac_jobs", async () => {
    // 1. Count current active jobs (only running, not dispatched anymore)
    const activeCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(iacJobs)
      .where(eq(iacJobs.status, "running"))

    const activeTotal = activeCountResult[0]?.count ?? 0
    let availableSlots = Math.max(0, limits.maxTotal - activeTotal)

    if (availableSlots === 0) {
      // At global limit
      const queuedResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(iacJobs)
        .where(eq(iacJobs.status, "queued"))

      return {
        jobs: [],
        blockedByGlobalLimit: queuedResult[0]?.count ?? 0,
        blockedByGroupLimit: 0,
        totalQueued: queuedResult[0]?.count ?? 0,
        groupsWithQueuedWork: 0,
      }
    }

    // 2. Get run groups with queued work
    const groupsWithWork = await db
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
        jobs: [],
        blockedByGlobalLimit: 0,
        blockedByGroupLimit: 0,
        totalQueued: 0,
        groupsWithQueuedWork: 0,
      }
    }

    const totalQueued = groupsWithWork.reduce((sum, g) => sum + g.queuedCount, 0)
    const groupsWithQueuedWork = groupsWithWork.length

    // 3. Count active jobs per run group
    const activeByGroupResult = await db
      .select({
        runGroupId: workspaceDeployments.runGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .where(eq(iacJobs.status, "running"))
      .groupBy(workspaceDeployments.runGroupId)

    const activeByGroup = new Map<string, number>()
    for (const row of activeByGroupResult) {
      activeByGroup.set(row.runGroupId ?? "no-group", row.count)
    }

    // 4. For each group, fetch top N jobs ordered by priority
    const jobsByGroup = new Map<string, IacJob[]>()
    let blockedByGroupLimit = 0

    for (const { runGroupId, queuedCount } of groupsWithWork) {
      const groupKey = runGroupId ?? "no-group"
      const currentActive = activeByGroup.get(groupKey) ?? 0
      const groupCapacity = Math.max(0, limits.maxPerRunGroup - currentActive)

      if (groupCapacity === 0) {
        blockedByGroupLimit += queuedCount
        continue
      }

      const groupJobs = await db
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

      const jobs: IacJob[] = groupJobs.map((row) => row.iac_jobs)

      if (jobs.length > 0) {
        jobsByGroup.set(groupKey, jobs)
      }

      if (queuedCount > groupCapacity) {
        blockedByGroupLimit += queuedCount - groupCapacity
      }
    }

    if (jobsByGroup.size === 0) {
      return {
        jobs: [],
        blockedByGlobalLimit: 0,
        blockedByGroupLimit,
        totalQueued,
        groupsWithQueuedWork,
      }
    }

    // 5. Round-robin interleave jobs from all groups
    const selected: IacJob[] = []
    let blockedByGlobalLimit = 0

    const groupIds = Array.from(jobsByGroup.keys())
    const groupIndices = new Map<string, number>()
    for (const gid of groupIds) {
      groupIndices.set(gid, 0)
    }

    let madeProgress = true
    while (madeProgress && selected.length < availableSlots) {
      madeProgress = false

      for (const groupId of groupIds) {
        if (selected.length >= availableSlots) {
          // Count remaining fetched jobs as blocked
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
          continue
        }

        selected.push(jobs[idx])
        groupIndices.set(groupId, idx + 1)
        madeProgress = true
      }
    }

    return {
      jobs: selected,
      blockedByGlobalLimit,
      blockedByGroupLimit,
      totalQueued,
      groupsWithQueuedWork,
    }
  })
}
