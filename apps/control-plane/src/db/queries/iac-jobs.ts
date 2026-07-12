import { randomUUID } from "node:crypto"

import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import {
  iacJobHistory,
  iacJobs,
  iacJobStatusEnum,
  iacJobTypeEnum,
  organizations,
  runGroups,
  tfRuns,
  workspaceDeployments,
} from "../schema.ts"
import {
  withDbSpan,
  logger,
  getJobQueueWaitHistogram,
  getJobRunDurationHistogram,
  getJobHeartbeatsCounter,
  getJobStateTransitionsCounter,
  getRunnerStartupDurationHistogram,
  getRunnerTaskDurationHistogram,
} from "../../lib/telemetry.ts"
import { events } from "../../lib/events.ts"
import { updateDeploymentStatus } from "./workspace-deployments.ts"
import { updateRunStatus } from "./tf-runs.ts"
import { recomputeRunGroupStatus } from "./run-groups.ts"
import { cascadeFailure } from "../../lib/deployment-side-effects.ts"

export type IacJob = typeof iacJobs.$inferSelect
export type NewIacJob = typeof iacJobs.$inferInsert
// Infer types from the enum definitions for compile-time safety
export type IacJobType = (typeof iacJobTypeEnum.enumValues)[number]
export type IacJobStatus = (typeof iacJobStatusEnum.enumValues)[number]
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const SPAWN_LEASE_AVAILABLE_SQL = sql`${iacJobs.spawnLeaseExpiresAt} IS NULL OR ${iacJobs.spawnLeaseExpiresAt} < NOW()`

function pickLatestJob(a?: IacJob, b?: IacJob): IacJob | undefined {
  if (!a) return b
  if (!b) return a

  const queuedAtDiff = a.queuedAt.getTime() - b.queuedAt.getTime()
  if (queuedAtDiff !== 0) {
    return queuedAtDiff > 0 ? a : b
  }

  return a.id > b.id ? a : b
}

async function archiveIacJobs(tx: DbTransaction, jobsToArchive: IacJob[]): Promise<void> {
  if (jobsToArchive.length === 0) {
    return
  }

  await tx.insert(iacJobHistory).values(jobsToArchive)
  await tx.delete(iacJobs).where(inArray(iacJobs.id, jobsToArchive.map((job) => job.id)))
}

/**
 * Create a new IaC job in the queue.
 */
export async function createIacJob(values: {
  /** @deprecated Use deploymentId */
  previewId?: string
  deploymentId?: string
  runGroupId?: string | null
  jobType: IacJobType
}): Promise<IacJob> {
  const deploymentId = values.deploymentId ?? values.previewId
  if (!deploymentId) {
    throw new Error("Either deploymentId or previewId is required")
  }

  return withDbSpan("insert", "iac_jobs", async () => {
    const runGroupId = values.runGroupId === undefined
      ? (
          await db
            .select({ runGroupId: workspaceDeployments.runGroupId })
            .from(workspaceDeployments)
            .where(eq(workspaceDeployments.id, deploymentId))
            .limit(1)
        )[0]?.runGroupId ?? null
      : values.runGroupId
    const rows = await db
      .insert(iacJobs)
      .values({
        deploymentId,
        runGroupId,
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
    const rows = await db
      .update(iacJobs)
      .set({
        blockedAt: new Date(),
        blockedReason: reason,
      })
      .where(and(eq(iacJobs.id, jobId), eq(iacJobs.status, "queued")))
      .returning({
        deploymentId: iacJobs.deploymentId,
      })

    const updated = rows[0]
    if (updated) {
      events.emitJobUpdate(jobId, updated.deploymentId)
    }
  })
}

export async function clearJobBlocked(jobId: string): Promise<void> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        blockedAt: null,
        blockedReason: null,
      })
      .where(and(
        eq(iacJobs.id, jobId),
        sql`${iacJobs.blockedAt} IS NOT NULL OR ${iacJobs.blockedReason} IS NOT NULL`,
      ))
      .returning({
        deploymentId: iacJobs.deploymentId,
      })

    const updated = rows[0]
    if (updated) {
      events.emitJobUpdate(jobId, updated.deploymentId)
    }
  })
}

/**
 * Find a job by ID.
 */
export async function findIacJobById(id: string): Promise<IacJob | undefined> {
  return withDbSpan("select", "iac_jobs", async () => {
    const activeRows = await db
      .select()
      .from(iacJobs)
      .where(eq(iacJobs.id, id))
      .limit(1)

    if (activeRows[0]) {
      return activeRows[0]
    }

    const historyRows = await db
      .select()
      .from(iacJobHistory)
      .where(eq(iacJobHistory.id, id))
      .limit(1)

    return historyRows[0]
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
    const activeRows = await db
      .select()
      .from(iacJobs)
      .where(and(eq(iacJobs.deploymentId, deploymentId), eq(iacJobs.jobType, jobType)))
      .orderBy(sql`${iacJobs.queuedAt} DESC`)
      .limit(1)

    const historyRows = await db
      .select()
      .from(iacJobHistory)
      .where(and(eq(iacJobHistory.deploymentId, deploymentId), eq(iacJobHistory.jobType, jobType)))
      .orderBy(sql`${iacJobHistory.queuedAt} DESC`)
      .limit(1)

    return pickLatestJob(activeRows[0], historyRows[0])
  })
}

export async function findLatestJobForDeployment(
  deploymentId: string,
): Promise<IacJob | undefined> {
  return withDbSpan("select", "iac_jobs", async () => {
    const activeRows = await db
      .select()
      .from(iacJobs)
      .where(eq(iacJobs.deploymentId, deploymentId))
      .orderBy(sql`${iacJobs.queuedAt} DESC`)
      .limit(1)

    const historyRows = await db
      .select()
      .from(iacJobHistory)
      .where(eq(iacJobHistory.deploymentId, deploymentId))
      .orderBy(sql`${iacJobHistory.queuedAt} DESC`)
      .limit(1)

    return pickLatestJob(activeRows[0], historyRows[0])
  })
}

/**
 * Find the latest job per deployment for a batch of deployment IDs.
 * Returns a Map keyed by deploymentId.
 */
export async function findLatestJobsForDeployments(
  deploymentIds: string[],
): Promise<Map<string, IacJob>> {
  if (deploymentIds.length === 0) return new Map()

  return withDbSpan("select", "iac_jobs", async () => {
    const activeRows = await db
      .selectDistinctOn([iacJobs.deploymentId], {
        job: iacJobs,
      })
      .from(iacJobs)
      .where(inArray(iacJobs.deploymentId, deploymentIds))
      .orderBy(iacJobs.deploymentId, desc(iacJobs.queuedAt), desc(iacJobs.id))

    const historyRows = await db
      .selectDistinctOn([iacJobHistory.deploymentId], {
        job: iacJobHistory,
      })
      .from(iacJobHistory)
      .where(inArray(iacJobHistory.deploymentId, deploymentIds))
      .orderBy(iacJobHistory.deploymentId, desc(iacJobHistory.queuedAt), desc(iacJobHistory.id))

    const map = new Map<string, IacJob>()

    for (const { job } of activeRows) {
      map.set(job.deploymentId, job)
    }

    for (const { job } of historyRows) {
      map.set(job.deploymentId, pickLatestJob(map.get(job.deploymentId), job)!)
    }

    return map
  })
}

export async function cancelRunningJobForDeploymentAndType(
  deploymentId: string,
  jobType: IacJobType,
): Promise<IacJob | undefined> {
  return withDbSpan("update", "iac_jobs", async () => {
    const job = await db.transaction(async (tx) => {
      const rows = await tx
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

      const updatedJob = rows[0]
      if (!updatedJob) {
        return undefined
      }

      await archiveIacJobs(tx, [updatedJob])
      return updatedJob
    })

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

export interface AcquireJobSpawnLeaseResult {
  acquired: boolean
  leaseToken?: string
  leaseExpiresAt?: Date
}

/**
 * Acquire a short-lived spawn lease for a queued job.
 *
 * This prevents multiple scheduler polls from spawning duplicate runners for the
 * same queued job before any runner claims it.
 */
export async function acquireJobSpawnLease(
  jobId: string,
  holderId: string,
  ttlMs: number,
): Promise<AcquireJobSpawnLeaseResult> {
  return withDbSpan("update", "iac_jobs", async () => {
    const leaseToken = randomUUID()
    const leaseExpiresAt = new Date(Date.now() + ttlMs)

    const rows = await db
      .update(iacJobs)
      .set({
        spawnLeaseToken: leaseToken,
        spawnLeaseHolder: holderId,
        spawnLeaseExpiresAt: leaseExpiresAt,
        lastSpawnAttemptAt: new Date(),
        spawnAttempts: sql`${iacJobs.spawnAttempts} + 1`,
      })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "queued"),
          sql`(${SPAWN_LEASE_AVAILABLE_SQL})`,
        ),
      )
      .returning({ id: iacJobs.id })

    if (rows.length === 0) {
      return { acquired: false }
    }

    return {
      acquired: true,
      leaseToken,
      leaseExpiresAt,
    }
  })
}

/**
 * Release a spawn lease after a fast spawn failure.
 */
export async function releaseJobSpawnLease(
  jobId: string,
  leaseToken: string,
): Promise<void> {
  return withDbSpan("update", "iac_jobs", async () => {
    await db
      .update(iacJobs)
      .set({
        spawnLeaseToken: null,
        spawnLeaseHolder: null,
        spawnLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "queued"),
          eq(iacJobs.spawnLeaseToken, leaseToken),
        ),
      )
  })
}

/**
 * Record that a job was successfully dispatched to a runner.
 *
 * Jobs remain in `queued` state until a runner claims them, but this timestamp
 * lets us measure startup and task-lifetime proxy metrics.
 */
export async function markJobDispatched(
  jobId: string,
  leaseToken: string,
): Promise<void> {
  return withDbSpan("update", "iac_jobs", async () => {
    await db
      .update(iacJobs)
      .set({
        dispatchedAt: new Date(),
      })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "queued"),
          eq(iacJobs.spawnLeaseToken, leaseToken),
        ),
      )
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
    const job = await db.transaction(async (tx) => {
      const rows = await tx
        .update(iacJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          result,
        })
        .where(eq(iacJobs.id, jobId))
        .returning()

      const updatedJob = rows[0]
      if (!updatedJob) {
        return undefined
      }

      await archiveIacJobs(tx, [updatedJob])
      return updatedJob
    })

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
    const job = await db.transaction(async (tx) => {
      const rows = await tx
        .update(iacJobs)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage,
        })
        .where(eq(iacJobs.id, jobId))
        .returning()

      const updatedJob = rows[0]
      if (!updatedJob) {
        return undefined
      }

      await archiveIacJobs(tx, [updatedJob])
      return updatedJob
    })

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
      const updatedRows = await tx
        .update(iacJobs)
        .set({
          status: "system_error",
          completedAt,
          errorMessage: "Job timed out (worker stopped sending heartbeats). Use 'Run Again' to retry.",
        })
        .where(eq(iacJobs.id, jobId))
        .returning()

      const updatedJob = updatedRows[0]
      if (!updatedJob) {
        return { failed: false }
      }

      await archiveIacJobs(tx, [updatedJob])

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

      return { failed: true, job: updatedJob }
    })
  }).then(async (result) => {
    // Update deployment status outside the transaction to avoid circular import issues
    if (result.failed && result.job) {
      const errorMessage = "Job timed out (worker stopped sending heartbeats). Use 'Run Again' to retry."

      const runningRunConditions = [
        eq(tfRuns.deploymentId, result.job.deploymentId),
        eq(tfRuns.status, "running"),
      ]
      if (result.job.runGroupId) {
        runningRunConditions.push(eq(tfRuns.runGroupId, result.job.runGroupId))
      }
      const latestRunningRun = await db
        .select({ id: tfRuns.id })
        .from(tfRuns)
        .where(and(...runningRunConditions))
        .orderBy(desc(tfRuns.createdAt))
        .limit(1)

      if (latestRunningRun[0]) {
        await updateRunStatus(latestRunningRun[0].id, result.job.deploymentId, "failed", {
          completedAt: new Date(),
          errorMessage,
        })
      } else if (result.job.runGroupId) {
        // Defensive recompute when the corresponding tf_run cannot be found.
        // This avoids run groups getting stuck in "running" after stale job cleanup.
        await recomputeRunGroupStatus(result.job.runGroupId)
      }

      await updateDeploymentStatus(result.job.deploymentId, "system_error")
      await cascadeFailure(result.job.deploymentId)
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
        orgSlug: string
        repo: string
        environmentKind: "named" | "transient"
        environmentName: string
        prNumber: number | null
        workspacePath: string
        ref: string
        headSha: string
        stateKey: string
        installationId: number | null
        runGroupId: string | null
      }
      runGroup: {
        id: string
        workspaceS3Key: string | null
        executionSnapshot: typeof runGroups.$inferSelect.executionSnapshot
      } | null
      /** @deprecated Use deployment */
      preview: {
        id: string
        orgId: string
        orgSlug: string
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
    const activeRows = await db
      .select({
        job: iacJobs,
        deployment: {
          id: workspaceDeployments.id,
          orgId: workspaceDeployments.orgId,
          orgSlug: organizations.slug,
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
        runGroup: {
          id: runGroups.id,
          workspaceS3Key: runGroups.workspaceS3Key,
          executionSnapshot: runGroups.executionSnapshot,
        },
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .innerJoin(organizations, eq(workspaceDeployments.orgId, organizations.id))
      .leftJoin(runGroups, eq(iacJobs.runGroupId, runGroups.id))
      .where(eq(iacJobs.id, jobId))
      .limit(1)

    if (activeRows.length > 0) {
      const { job, deployment, runGroup } = activeRows[0]
      // Provide backward-compatible preview alias
      return { ...job, deployment, runGroup, preview: deployment }
    }

    const historyRows = await db
      .select({
        job: iacJobHistory,
        deployment: {
          id: workspaceDeployments.id,
          orgId: workspaceDeployments.orgId,
          orgSlug: organizations.slug,
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
        runGroup: {
          id: runGroups.id,
          workspaceS3Key: runGroups.workspaceS3Key,
          executionSnapshot: runGroups.executionSnapshot,
        },
      })
      .from(iacJobHistory)
      .innerJoin(workspaceDeployments, eq(iacJobHistory.deploymentId, workspaceDeployments.id))
      .innerJoin(organizations, eq(workspaceDeployments.orgId, organizations.id))
      .leftJoin(runGroups, eq(iacJobHistory.runGroupId, runGroups.id))
      .where(eq(iacJobHistory.id, jobId))
      .limit(1)

    if (historyRows.length === 0) return undefined

    const { job, deployment, runGroup } = historyRows[0]
    return { ...job, deployment, runGroup, preview: deployment }
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
    const result = await db.transaction(async (tx) => {
      const rows = await tx
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
        .returning()

      await archiveIacJobs(tx, rows)
      return rows
    })

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
        runGroupId: iacJobs.runGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(iacJobs)
      .where(eq(iacJobs.status, "running"))
      .groupBy(iacJobs.runGroupId)

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
        runGroupId: iacJobs.runGroupId,
      })
      .from(iacJobs)
      .where(and(eq(iacJobs.status, "queued"), sql`(${SPAWN_LEASE_AVAILABLE_SQL})`))
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
  spawnLeaseToken?: string,
): Promise<{ claimed: boolean; job?: IacJob; queueWaitMs?: number }> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({
        status: "running",
        workerId,
        startedAt: new Date(),
        lastHeartbeat: new Date(),
        spawnLeaseToken: null,
        spawnLeaseHolder: null,
        spawnLeaseExpiresAt: null,
        attempts: sql`${iacJobs.attempts} + 1`,
      })
      .where(
        and(
          eq(iacJobs.id, jobId),
          eq(iacJobs.status, "queued"), // Only claim if still queued
          spawnLeaseToken
            ? and(
                eq(iacJobs.spawnLeaseToken, spawnLeaseToken),
                sql`${iacJobs.spawnLeaseExpiresAt} > NOW()`,
              )
            : sql`(${SPAWN_LEASE_AVAILABLE_SQL})`,
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
      const dispatchToClaimMs = job.startedAt && job.dispatchedAt
        ? job.startedAt.getTime() - job.dispatchedAt.getTime()
        : null

      // Record metrics
      getJobQueueWaitHistogram().record(queueWaitMs, { job_type: job.jobType })
      if (dispatchToClaimMs != null) {
        getRunnerStartupDurationHistogram().record(dispatchToClaimMs, {
          job_type: job.jobType,
          dispatch_mode: "burst",
        })
      }
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
        "duration.dispatch_to_claim_ms": dispatchToClaimMs ?? undefined,
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
    const job = await db.transaction(async (tx) => {
      const rows = await tx
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

      const updatedJob = rows[0]
      if (!updatedJob) {
        return undefined
      }

      await archiveIacJobs(tx, [updatedJob])
      return updatedJob
    })

    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)

      // Calculate run duration
      const runDurationMs = job.completedAt && job.startedAt
        ? job.completedAt.getTime() - job.startedAt.getTime()
        : 0
      const taskDurationMs = job.completedAt && job.dispatchedAt
        ? job.completedAt.getTime() - job.dispatchedAt.getTime()
        : null

      // Record metrics
      getJobRunDurationHistogram().record(runDurationMs, {
        job_type: job.jobType,
        status: "completed",
      })
      if (taskDurationMs != null) {
        getRunnerTaskDurationHistogram().record(taskDurationMs, {
          job_type: job.jobType,
          dispatch_mode: "burst",
          status: "completed",
        })
      }
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
        "duration.task_ms": taskDurationMs ?? undefined,
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
    const job = await db.transaction(async (tx) => {
      const rows = await tx
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

      const updatedJob = rows[0]
      if (!updatedJob) {
        return undefined
      }

      await archiveIacJobs(tx, [updatedJob])
      return updatedJob
    })

    if (job) {
      events.emitJobUpdate(job.id, job.deploymentId)

      // Calculate run duration
      const runDurationMs = job.completedAt && job.startedAt
        ? job.completedAt.getTime() - job.startedAt.getTime()
        : 0
      const taskDurationMs = job.completedAt && job.dispatchedAt
        ? job.completedAt.getTime() - job.dispatchedAt.getTime()
        : null

      // Record metrics
      getJobRunDurationHistogram().record(runDurationMs, {
        job_type: job.jobType,
        status: "failed",
      })
      if (taskDurationMs != null) {
        getRunnerTaskDurationHistogram().record(taskDurationMs, {
          job_type: job.jobType,
          dispatch_mode: "burst",
          status: "failed",
        })
      }
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
        "duration.task_ms": taskDurationMs ?? undefined,
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

const JOB_BLOCK_PRIORITY_SQL = sql<number>`
  CASE
    WHEN ${iacJobs.blockedAt} IS NULL THEN 0
    ELSE 1
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

function roundRobinSelectJobs(
  jobsByGroup: Map<string, IacJob[]>,
  availableSlots: number,
): { selected: IacJob[]; blockedByGlobalLimit: number } {
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
    selected,
    blockedByGlobalLimit,
  }
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
        .where(and(eq(iacJobs.status, "queued"), sql`(${SPAWN_LEASE_AVAILABLE_SQL})`))

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
        runGroupId: iacJobs.runGroupId,
        queuedCount: sql<number>`count(*)::int`,
      })
      .from(iacJobs)
      .where(and(eq(iacJobs.status, "queued"), sql`(${SPAWN_LEASE_AVAILABLE_SQL})`))
      .groupBy(iacJobs.runGroupId)

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
        runGroupId: iacJobs.runGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(iacJobs)
      .where(eq(iacJobs.status, "running"))
      .groupBy(iacJobs.runGroupId)

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
            sql`(${SPAWN_LEASE_AVAILABLE_SQL})`,
            runGroupId
              ? eq(iacJobs.runGroupId, runGroupId)
              : sql`${iacJobs.runGroupId} IS NULL`,
          ),
        )
        .orderBy(JOB_BLOCK_PRIORITY_SQL, JOB_TYPE_PRIORITY_SQL, iacJobs.queuedAt)
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
    const { selected, blockedByGlobalLimit } = roundRobinSelectJobs(jobsByGroup, availableSlots)

    return {
      jobs: selected,
      blockedByGlobalLimit,
      blockedByGroupLimit,
      totalQueued,
      groupsWithQueuedWork,
    }
  })
}

/**
 * Find queued jobs an active warm runner may claim for a single org.
 *
 * This applies the same global and per-run-group concurrency limits as the
 * normal scheduler path, but only considers queued jobs that belong to the
 * provided org.
 */
export async function findQueuedJobsForWarmRunner(
  orgId: string,
  limits: ConcurrencyLimits,
  availableSlots: number = 1,
): Promise<IacJob[]> {
  return withDbSpan("select", "iac_jobs", async () => {
    const activeCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(iacJobs)
      .where(eq(iacJobs.status, "running"))

    const activeTotal = activeCountResult[0]?.count ?? 0
    const availableGlobalSlots = Math.max(0, limits.maxTotal - activeTotal)
    const effectiveAvailableSlots = Math.min(availableSlots, availableGlobalSlots)

    if (effectiveAvailableSlots === 0) {
      return []
    }

    const groupsWithWork = await db
      .select({
        runGroupId: iacJobs.runGroupId,
        queuedCount: sql<number>`count(*)::int`,
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .where(
        and(
          eq(iacJobs.status, "queued"),
          eq(workspaceDeployments.orgId, orgId),
          sql`(${SPAWN_LEASE_AVAILABLE_SQL})`,
        ),
      )
      .groupBy(iacJobs.runGroupId)

    if (groupsWithWork.length === 0) {
      return []
    }

    const activeByGroupResult = await db
      .select({
        runGroupId: iacJobs.runGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .where(
        and(
          eq(iacJobs.status, "running"),
          eq(workspaceDeployments.orgId, orgId),
        ),
      )
      .groupBy(iacJobs.runGroupId)

    const activeByGroup = new Map<string, number>()
    for (const row of activeByGroupResult) {
      activeByGroup.set(row.runGroupId ?? "no-group", row.count)
    }

    const jobsByGroup = new Map<string, IacJob[]>()

    for (const { runGroupId } of groupsWithWork) {
      const groupKey = runGroupId ?? "no-group"
      const currentActive = activeByGroup.get(groupKey) ?? 0
      const groupCapacity = Math.max(0, limits.maxPerRunGroup - currentActive)

      if (groupCapacity === 0) {
        continue
      }

      const groupJobs = await db
        .select()
        .from(iacJobs)
        .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
        .where(
          and(
            eq(iacJobs.status, "queued"),
            eq(workspaceDeployments.orgId, orgId),
            sql`(${SPAWN_LEASE_AVAILABLE_SQL})`,
            runGroupId
              ? eq(iacJobs.runGroupId, runGroupId)
              : sql`${iacJobs.runGroupId} IS NULL`,
          ),
        )
        .orderBy(JOB_BLOCK_PRIORITY_SQL, JOB_TYPE_PRIORITY_SQL, iacJobs.queuedAt)
        .limit(groupCapacity)

      const jobs = groupJobs.map((row) => row.iac_jobs)
      if (jobs.length > 0) {
        jobsByGroup.set(groupKey, jobs)
      }
    }

    if (jobsByGroup.size === 0) {
      return []
    }

    return roundRobinSelectJobs(jobsByGroup, effectiveAvailableSlots).selected
  })
}

export async function countEligibleQueuedJobsForOrg(
  orgId: string,
  excludedWorkspacePaths: string[] = [],
): Promise<number> {
  return withDbSpan("select", "iac_jobs", async () => {
    const conditions = [
      eq(iacJobs.status, "queued"),
      eq(workspaceDeployments.orgId, orgId),
      isNull(iacJobs.blockedAt),
      sql`(${SPAWN_LEASE_AVAILABLE_SQL})`,
    ] as const

    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .where(
        and(
          ...conditions,
          excludedWorkspacePaths.length > 0
            ? notInArray(workspaceDeployments.workspacePath, excludedWorkspacePaths)
            : sql`TRUE`,
        ),
      )

    return rows[0]?.count ?? 0
  })
}
