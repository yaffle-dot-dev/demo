import { randomUUID } from "node:crypto"

import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import {
  iacJobHistory,
  iacJobs,
  iacJobStatusEnum,
  iacJobTypeEnum,
  organizations,
  principalRepoBindings,
  runGroups,
  stateVersions,
  tfRuns,
  workspaceDeployments,
  workspaces,
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
import { type ApplyDecision, isApplyDecision } from "../../lib/execution-mutation.ts"
import { events } from "../../lib/events.ts"
import { updateDeploymentStatus } from "./workspace-deployments.ts"
import { updateRunStatus } from "./tf-runs.ts"
import { unlockWorkspaceForDeploymentRun } from "./workspaces.ts"
import { recomputeRunGroupStatus } from "./run-groups.ts"
import { cascadeFailure } from "../../lib/deployment-side-effects.ts"
import {
  ExecutionContextAssociationError,
  isExecutionContextAssociationValid,
  type ExecutionSnapshotV1,
} from "../../lib/execution-snapshot.ts"

export type IacJob = typeof iacJobs.$inferSelect
export type NewIacJob = typeof iacJobs.$inferInsert
// Infer types from the enum definitions for compile-time safety
export type IacJobType = (typeof iacJobTypeEnum.enumValues)[number]
export type IacJobStatus = (typeof iacJobStatusEnum.enumValues)[number]
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

interface ExecutionContextDeployment {
  orgId: string
  repo: string
  environmentKind: "named" | "transient"
  environmentName: string
  workspacePath: string
  installationId?: number | null
}

interface ExecutionContextRunGroup {
  id?: string
  orgId: string
  repo: string
  environmentKind: "named" | "transient"
  environmentName: string
  ref: string
  headSha: string
  selectedWorkspacePaths: unknown
  repoBindingId: string | null
  workspaceS3Key?: string | null
  executionSnapshot: ExecutionSnapshotV1 | null
}

function runGroupMatchesDeployment(
  runGroup: ExecutionContextRunGroup,
  deployment: ExecutionContextDeployment,
  canonicalRepoNamespace: string | null,
): boolean {
  if (!runGroup.executionSnapshot) {
    return (
      deployment.environmentKind !== "transient" &&
      runGroup.orgId === deployment.orgId &&
      runGroup.repo === deployment.repo &&
      runGroup.environmentKind === deployment.environmentKind &&
      runGroup.environmentName === deployment.environmentName
    )
  }
  if (deployment.environmentKind === "transient" && !runGroup.workspaceS3Key) {
    return false
  }

  return isExecutionContextAssociationValid({
    snapshot: runGroup.executionSnapshot,
    runGroup,
    resource: deployment,
    canonicalRepoNamespace,
    requireRepoBinding: deployment.environmentKind === "transient",
  })
}

async function resolveRunGroupIdForDeployment(
  deploymentId: string,
  requestedRunGroupId: string | null | undefined,
): Promise<string | null> {
  const deployment = (
    await db
      .select({
        runGroupId: workspaceDeployments.runGroupId,
        orgId: workspaceDeployments.orgId,
        repo: workspaceDeployments.repo,
        environmentKind: workspaceDeployments.environmentKind,
        environmentName: workspaceDeployments.environmentName,
        workspacePath: workspaceDeployments.workspacePath,
      })
      .from(workspaceDeployments)
      .where(eq(workspaceDeployments.id, deploymentId))
      .limit(1)
  )[0]

  if (!deployment) {
    throw new ExecutionContextAssociationError(`Deployment ${deploymentId} does not exist`)
  }

  const runGroupId = requestedRunGroupId === undefined ? deployment.runGroupId : requestedRunGroupId
  if (!runGroupId) {
    throw new ExecutionContextAssociationError(
      `Deployment ${deploymentId} is missing its execution run group`,
    )
  }

  const result = (
    await db
      .select({
        runGroup: runGroups,
        canonicalRepoNamespace: principalRepoBindings.canonicalRepoNamespace,
      })
      .from(runGroups)
      .leftJoin(principalRepoBindings, eq(runGroups.repoBindingId, principalRepoBindings.id))
      .where(eq(runGroups.id, runGroupId))
      .limit(1)
  )[0]

  if (
    !result ||
    !runGroupMatchesDeployment(result.runGroup, deployment, result.canonicalRepoNamespace)
  ) {
    throw new ExecutionContextAssociationError(
      `Run group ${runGroupId} does not own deployment ${deploymentId}`,
    )
  }

  return runGroupId
}

async function assertMergeImpactTarget(values: {
  deploymentId: string
  runGroupId: string
  targetWorkspaceId: string
  targetStateVersionId: string
}): Promise<void> {
  const result = (
    await db
      .select({
        deployment: workspaceDeployments,
        runGroup: runGroups,
        workspace: workspaces,
        stateVersion: stateVersions,
      })
      .from(workspaceDeployments)
      .innerJoin(runGroups, eq(runGroups.id, values.runGroupId))
      .innerJoin(workspaces, eq(workspaces.id, values.targetWorkspaceId))
      .innerJoin(stateVersions, eq(stateVersions.id, values.targetStateVersionId))
      .where(eq(workspaceDeployments.id, values.deploymentId))
      .limit(1)
  )[0]
  const target = result?.runGroup.executionSnapshot?.mergeImpact
  const targetWorkspace = target?.workspaces.find(
    (workspace) => workspace.path === result?.deployment.workspacePath,
  )
  if (
    !result ||
    !target ||
    !targetWorkspace ||
    result.runGroup.id !== values.runGroupId ||
    result.deployment.runGroupId !== values.runGroupId ||
    result.runGroup.orgId !== result.deployment.orgId ||
    result.runGroup.repo !== result.deployment.repo ||
    result.workspace.orgId !== result.deployment.orgId ||
    result.workspace.repo !== result.deployment.repo ||
    result.workspace.workspacePath !== result.deployment.workspacePath ||
    result.workspace.environmentKind !== "named" ||
    result.workspace.environmentName !== target.environmentName ||
    result.workspace.ref !== target.ref ||
    result.workspace.status !== "active" ||
    result.workspace.currentStateVersionId !== result.stateVersion.id ||
    result.stateVersion.workspaceId !== result.workspace.id ||
    result.stateVersion.status !== "finalized"
  ) {
    throw new ExecutionContextAssociationError(
      `Merge-impact target does not belong to deployment ${values.deploymentId}`,
    )
  }
}

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
  await tx.delete(iacJobs).where(
    inArray(
      iacJobs.id,
      jobsToArchive.map((job) => job.id),
    ),
  )
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
  planPurpose?: "environment" | "merge_impact"
  targetWorkspaceId?: string
  targetStateVersionId?: string
  applyDecision?: ApplyDecision
}): Promise<IacJob> {
  const deploymentId = values.deploymentId ?? values.previewId
  if (!deploymentId) {
    throw new Error("Either deploymentId or previewId is required")
  }

  return withDbSpan("insert", "iac_jobs", async () => {
    const runGroupId = await resolveRunGroupIdForDeployment(deploymentId, values.runGroupId)
    if (values.jobType === "apply") {
      if (
        !runGroupId ||
        !isApplyDecision(values.applyDecision) ||
        values.applyDecision.runGroupId !== runGroupId
      ) {
        throw new ExecutionContextAssociationError(
          "Apply jobs require an authorized decision for the exact execution context",
        )
      }
    } else if (values.applyDecision !== undefined) {
      throw new ExecutionContextAssociationError("Only apply jobs may carry an apply decision")
    }
    const planPurpose = values.planPurpose ?? "environment"
    if (planPurpose === "merge_impact") {
      if (
        values.jobType !== "plan" ||
        !runGroupId ||
        !values.targetWorkspaceId ||
        !values.targetStateVersionId
      ) {
        throw new ExecutionContextAssociationError("Merge-impact jobs require a pinned plan target")
      }
      await assertMergeImpactTarget({
        deploymentId,
        runGroupId,
        targetWorkspaceId: values.targetWorkspaceId,
        targetStateVersionId: values.targetStateVersionId,
      })
    }
    const rows = await db
      .insert(iacJobs)
      .values({
        deploymentId,
        runGroupId,
        jobType: values.jobType,
        planPurpose,
        targetWorkspaceId: values.targetWorkspaceId,
        targetStateVersionId: values.targetStateVersionId,
        applyDecision: values.applyDecision,
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

export async function markJobBlocked(jobId: string, reason: string): Promise<void> {
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
      .where(
        and(
          eq(iacJobs.id, jobId),
          sql`${iacJobs.blockedAt} IS NOT NULL OR ${iacJobs.blockedReason} IS NOT NULL`,
        ),
      )
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
    const activeRows = await db.select().from(iacJobs).where(eq(iacJobs.id, id)).limit(1)

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
      .where(
        and(
          eq(iacJobs.deploymentId, deploymentId),
          eq(iacJobs.jobType, jobType),
          eq(iacJobs.planPurpose, "environment"),
        ),
      )
      .orderBy(sql`${iacJobs.queuedAt} DESC`)
      .limit(1)

    const historyRows = await db
      .select()
      .from(iacJobHistory)
      .where(
        and(
          eq(iacJobHistory.deploymentId, deploymentId),
          eq(iacJobHistory.jobType, jobType),
          eq(iacJobHistory.planPurpose, "environment"),
        ),
      )
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
      .where(and(eq(iacJobs.deploymentId, deploymentId), eq(iacJobs.planPurpose, "environment")))
      .orderBy(sql`${iacJobs.queuedAt} DESC`)
      .limit(1)

    const historyRows = await db
      .select()
      .from(iacJobHistory)
      .where(
        and(
          eq(iacJobHistory.deploymentId, deploymentId),
          eq(iacJobHistory.planPurpose, "environment"),
        ),
      )
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
      .where(
        and(inArray(iacJobs.deploymentId, deploymentIds), eq(iacJobs.planPurpose, "environment")),
      )
      .orderBy(iacJobs.deploymentId, desc(iacJobs.queuedAt), desc(iacJobs.id))

    const historyRows = await db
      .selectDistinctOn([iacJobHistory.deploymentId], {
        job: iacJobHistory,
      })
      .from(iacJobHistory)
      .where(
        and(
          inArray(iacJobHistory.deploymentId, deploymentIds),
          eq(iacJobHistory.planPurpose, "environment"),
        ),
      )
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

class RunnerCancellationConflict extends Error {}

export async function cancelRunningJobForDeploymentAndType(capability: {
  jobId: string
  runId: string
  deploymentId: string
  runGroupId: string
  jobType: IacJobType
  errorMessage: string
}): Promise<IacJob | undefined> {
  return withDbSpan("update", "iac_jobs", async () => {
    let job: IacJob | undefined
    try {
      job = await db.transaction(async (tx) => {
        const completedAt = new Date()
        const rows = await tx
          .update(iacJobs)
          .set({ status: "cancelled", completedAt })
          .where(
            and(
              eq(iacJobs.id, capability.jobId),
              eq(iacJobs.deploymentId, capability.deploymentId),
              eq(iacJobs.runGroupId, capability.runGroupId),
              eq(iacJobs.jobType, capability.jobType),
              eq(iacJobs.planPurpose, "environment"),
              eq(iacJobs.status, "running"),
            ),
          )
          .returning()

        const updatedJob = rows[0]
        if (!updatedJob) {
          return undefined
        }
        const runs = await tx
          .update(tfRuns)
          .set({ status: "cancelled", completedAt, errorMessage: capability.errorMessage })
          .where(
            and(
              eq(tfRuns.id, capability.runId),
              eq(tfRuns.jobId, capability.jobId),
              eq(tfRuns.deploymentId, capability.deploymentId),
              eq(tfRuns.runGroupId, capability.runGroupId),
              eq(tfRuns.runType, capability.jobType),
              eq(tfRuns.status, "running"),
            ),
          )
          .returning({ id: tfRuns.id })
        if (runs.length !== 1) {
          throw new RunnerCancellationConflict()
        }
        const deployments = await tx
          .update(workspaceDeployments)
          .set({ status: "pending" })
          .where(
            and(
              eq(workspaceDeployments.id, capability.deploymentId),
              eq(workspaceDeployments.runGroupId, capability.runGroupId),
            ),
          )
          .returning({ id: workspaceDeployments.id })
        if (deployments.length !== 1) {
          throw new RunnerCancellationConflict()
        }
        await tx
          .update(workspaces)
          .set({
            locked: false,
            lockedBy: null,
            lockedAt: null,
            lockReason: null,
            lockId: null,
          })
          .where(
            and(
              eq(workspaces.lockedBy, `run:${capability.runId}`),
              sql`EXISTS (
                SELECT 1
                FROM workspace_deployments
                WHERE workspace_deployments.id = ${capability.deploymentId}
                  AND workspaces.org_id = workspace_deployments.org_id
                  AND workspaces.repo = workspace_deployments.repo
                  AND workspaces.environment_kind = workspace_deployments.environment_kind
                  AND workspaces.environment_name = workspace_deployments.environment_name
                  AND workspaces.workspace_path = workspace_deployments.workspace_path
                  AND workspaces.ref = workspace_deployments.ref
              )`,
            ),
          )

        await archiveIacJobs(tx, [updatedJob])
        return updatedJob
      })
    } catch (error) {
      if (error instanceof RunnerCancellationConflict) {
        return undefined
      }
      throw error
    }

    if (!job) {
      return undefined
    }

    events.emitJobUpdate(job.id, capability.deploymentId)
    events.emitRunUpdate(capability.runId, capability.deploymentId)
    await recomputeRunGroupStatus(capability.runGroupId)
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
      "deployment.id": capability.deploymentId,
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
export async function updateJobEcsTask(jobId: string, taskArn: string): Promise<void> {
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
export async function releaseJobSpawnLease(jobId: string, leaseToken: string): Promise<void> {
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
export async function markJobDispatched(jobId: string, leaseToken: string): Promise<void> {
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
export async function failJob(jobId: string, errorMessage: string): Promise<IacJob | undefined> {
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
export async function findStaleJobs(staleThresholdMs: number = 5 * 60 * 1000): Promise<IacJob[]> {
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
export async function failStaleJob(jobId: string): Promise<{ failed: boolean }> {
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
      const isStillStale =
        !job.lastHeartbeat || Date.now() - job.lastHeartbeat.getTime() > 5 * 60 * 1000

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
          errorMessage:
            "Job timed out (worker stopped sending heartbeats). Use 'Run Again' to retry.",
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
      const errorMessage =
        "Job timed out (worker stopped sending heartbeats). Use 'Run Again' to retry."

      const latestRunningRun = await db
        .select({ id: tfRuns.id })
        .from(tfRuns)
        .where(and(eq(tfRuns.jobId, result.job.id), eq(tfRuns.status, "running")))
        .limit(1)

      if (latestRunningRun[0]) {
        await updateRunStatus(latestRunningRun[0].id, result.job.deploymentId, "failed", {
          completedAt: new Date(),
          errorMessage,
        })
        await unlockWorkspaceForDeploymentRun(result.job.deploymentId, latestRunningRun[0].id)
      } else if (result.job.runGroupId) {
        // Defensive recompute when the corresponding tf_run cannot be found.
        // This avoids run groups getting stuck in "running" after stale job cleanup.
        await recomputeRunGroupStatus(result.job.runGroupId)
      }

      if (result.job.planPurpose === "environment") {
        if (
          result.job.runGroupId &&
          (await updateDeploymentStatus(
            result.job.deploymentId,
            "system_error",
            result.job.runGroupId,
          ))
        ) {
          await cascadeFailure(result.job.deploymentId, result.job.runGroupId)
        }
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
        orgId: string
        repo: string
        environmentKind: "named" | "transient"
        environmentName: string
        ref: string
        headSha: string
        selectedWorkspacePaths: unknown
        repoBindingId: string | null
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
          orgId: runGroups.orgId,
          repo: runGroups.repo,
          environmentKind: runGroups.environmentKind,
          environmentName: runGroups.environmentName,
          ref: runGroups.ref,
          headSha: runGroups.headSha,
          selectedWorkspacePaths: runGroups.selectedWorkspacePaths,
          repoBindingId: runGroups.repoBindingId,
          workspaceS3Key: runGroups.workspaceS3Key,
          executionSnapshot: runGroups.executionSnapshot,
        },
        canonicalRepoNamespace: principalRepoBindings.canonicalRepoNamespace,
      })
      .from(iacJobs)
      .innerJoin(workspaceDeployments, eq(iacJobs.deploymentId, workspaceDeployments.id))
      .innerJoin(organizations, eq(workspaceDeployments.orgId, organizations.id))
      .leftJoin(
        runGroups,
        and(
          eq(iacJobs.runGroupId, runGroups.id),
          eq(runGroups.orgId, workspaceDeployments.orgId),
          eq(runGroups.repo, workspaceDeployments.repo),
          eq(runGroups.environmentKind, workspaceDeployments.environmentKind),
          eq(runGroups.environmentName, workspaceDeployments.environmentName),
        ),
      )
      .leftJoin(principalRepoBindings, eq(runGroups.repoBindingId, principalRepoBindings.id))
      .where(eq(iacJobs.id, jobId))
      .limit(1)

    if (activeRows.length > 0) {
      const { job, deployment, runGroup, canonicalRepoNamespace } = activeRows[0]
      const validatedRunGroup =
        runGroup &&
        deployment.runGroupId === job.runGroupId &&
        runGroupMatchesDeployment(runGroup, deployment, canonicalRepoNamespace)
          ? runGroup
          : null
      // Provide backward-compatible preview alias
      return { ...job, deployment, runGroup: validatedRunGroup, preview: deployment }
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
          orgId: runGroups.orgId,
          repo: runGroups.repo,
          environmentKind: runGroups.environmentKind,
          environmentName: runGroups.environmentName,
          ref: runGroups.ref,
          headSha: runGroups.headSha,
          selectedWorkspacePaths: runGroups.selectedWorkspacePaths,
          repoBindingId: runGroups.repoBindingId,
          workspaceS3Key: runGroups.workspaceS3Key,
          executionSnapshot: runGroups.executionSnapshot,
        },
        canonicalRepoNamespace: principalRepoBindings.canonicalRepoNamespace,
      })
      .from(iacJobHistory)
      .innerJoin(workspaceDeployments, eq(iacJobHistory.deploymentId, workspaceDeployments.id))
      .innerJoin(organizations, eq(workspaceDeployments.orgId, organizations.id))
      .leftJoin(
        runGroups,
        and(
          eq(iacJobHistory.runGroupId, runGroups.id),
          eq(runGroups.orgId, workspaceDeployments.orgId),
          eq(runGroups.repo, workspaceDeployments.repo),
          eq(runGroups.environmentKind, workspaceDeployments.environmentKind),
          eq(runGroups.environmentName, workspaceDeployments.environmentName),
        ),
      )
      .leftJoin(principalRepoBindings, eq(runGroups.repoBindingId, principalRepoBindings.id))
      .where(eq(iacJobHistory.id, jobId))
      .limit(1)

    if (historyRows.length === 0) return undefined

    const { job, deployment, runGroup, canonicalRepoNamespace } = historyRows[0]
    const validatedRunGroup =
      runGroup && runGroupMatchesDeployment(runGroup, deployment, canonicalRepoNamespace)
        ? runGroup
        : null
    return { ...job, deployment, runGroup: validatedRunGroup, preview: deployment }
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

    return db
      .select()
      .from(iacJobs)
      .where(and(...conditions))
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
  capability: { jobId: string; deploymentId: string; runGroupId: string },
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
          eq(iacJobs.id, capability.jobId),
          eq(iacJobs.deploymentId, capability.deploymentId),
          eq(iacJobs.runGroupId, capability.runGroupId),
          eq(iacJobs.status, "queued"), // Only claim if still queued
          sql`EXISTS (
            SELECT 1
            FROM workspace_deployments
            WHERE workspace_deployments.id = ${capability.deploymentId}
              AND workspace_deployments.run_group_id = ${capability.runGroupId}
          )`,
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
      const queueWaitMs =
        job.startedAt && job.queuedAt ? job.startedAt.getTime() - job.queuedAt.getTime() : 0
      const dispatchToClaimMs =
        job.startedAt && job.dispatchedAt
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
export async function heartbeatJob(capability: {
  jobId: string
  runId: string
  deploymentId: string
  runGroupId: string
}): Promise<{ success: boolean }> {
  return withDbSpan("update", "iac_jobs", async () => {
    const rows = await db
      .update(iacJobs)
      .set({ lastHeartbeat: new Date() })
      .where(
        and(
          eq(iacJobs.id, capability.jobId),
          eq(iacJobs.deploymentId, capability.deploymentId),
          eq(iacJobs.runGroupId, capability.runGroupId),
          eq(iacJobs.status, "running"),
          sql`EXISTS (
            SELECT 1
            FROM tf_runs
            WHERE tf_runs.id = ${capability.runId}
              AND tf_runs.job_id = ${capability.jobId}
              AND tf_runs.deployment_id = ${capability.deploymentId}
              AND tf_runs.run_group_id = ${capability.runGroupId}
              AND tf_runs.status = 'running'
          )`,
          sql`EXISTS (
            SELECT 1
            FROM workspace_deployments
            WHERE workspace_deployments.id = ${capability.deploymentId}
              AND workspace_deployments.run_group_id = ${capability.runGroupId}
          )`,
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

class RunnerSettlementConflict extends Error {}

export async function settleJobAndRunFromRunner(values: {
  capability: { jobId: string; runId: string; deploymentId: string; runGroupId: string }
  jobStatus: "completed" | "failed"
  jobResult?: Record<string, unknown>
  jobErrorMessage?: string
  runStatus: "success" | "failed"
  runUpdates: {
    completedAt: Date
    logOutput?: string
    planSummary?: string
    planJson?: unknown
    planFileS3Key?: string
    outputs?: unknown
    errorMessage?: string
  }
}): Promise<{ success: boolean; job?: IacJob }> {
  return withDbSpan("update", "iac_jobs", async () => {
    try {
      const job = await db.transaction(async (tx) => {
        const deployments = await tx
          .select({ id: workspaceDeployments.id })
          .from(workspaceDeployments)
          .where(
            and(
              eq(workspaceDeployments.id, values.capability.deploymentId),
              eq(workspaceDeployments.runGroupId, values.capability.runGroupId),
            ),
          )
          .for("share")
          .limit(1)
        if (deployments.length !== 1) {
          throw new RunnerSettlementConflict()
        }

        const jobs = await tx
          .update(iacJobs)
          .set({
            status: values.jobStatus,
            completedAt: values.runUpdates.completedAt,
            result: values.jobResult,
            errorMessage: values.jobErrorMessage,
          })
          .where(
            and(
              eq(iacJobs.id, values.capability.jobId),
              eq(iacJobs.deploymentId, values.capability.deploymentId),
              eq(iacJobs.runGroupId, values.capability.runGroupId),
              eq(iacJobs.status, "running"),
            ),
          )
          .returning()
        const updatedJob = jobs[0]
        if (!updatedJob) {
          throw new RunnerSettlementConflict()
        }

        const runs = await tx
          .update(tfRuns)
          .set({ status: values.runStatus, ...values.runUpdates })
          .where(
            and(
              eq(tfRuns.id, values.capability.runId),
              eq(tfRuns.jobId, values.capability.jobId),
              eq(tfRuns.deploymentId, values.capability.deploymentId),
              eq(tfRuns.runGroupId, values.capability.runGroupId),
              eq(tfRuns.status, "running"),
            ),
          )
          .returning({ id: tfRuns.id })
        if (runs.length !== 1) {
          throw new RunnerSettlementConflict()
        }

        await archiveIacJobs(tx, [updatedJob])
        return updatedJob
      })

      events.emitJobUpdate(job.id, job.deploymentId)
      events.emitRunUpdate(values.capability.runId, values.capability.deploymentId)
      await recomputeRunGroupStatus(values.capability.runGroupId)
      return { success: true, job }
    } catch (error) {
      if (error instanceof RunnerSettlementConflict) {
        return { success: false }
      }
      throw error
    }
  })
}

/**
 * Complete a job from runner with result.
 * Only succeeds if job is still in "running" state.
 *
 * @returns { success: true } if completed, { success: false } if job not running
 */
export async function completeJobFromRunner(
  capability: { jobId: string; deploymentId: string; runGroupId: string },
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
            eq(iacJobs.id, capability.jobId),
            eq(iacJobs.deploymentId, capability.deploymentId),
            eq(iacJobs.runGroupId, capability.runGroupId),
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
      const runDurationMs =
        job.completedAt && job.startedAt ? job.completedAt.getTime() - job.startedAt.getTime() : 0
      const taskDurationMs =
        job.completedAt && job.dispatchedAt
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
  capability: { jobId: string; deploymentId: string; runGroupId: string },
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
            eq(iacJobs.id, capability.jobId),
            eq(iacJobs.deploymentId, capability.deploymentId),
            eq(iacJobs.runGroupId, capability.runGroupId),
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
      const runDurationMs =
        job.completedAt && job.startedAt ? job.completedAt.getTime() - job.startedAt.getTime() : 0
      const taskDurationMs =
        job.completedAt && job.dispatchedAt
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

const JOB_PURPOSE_PRIORITY_SQL = sql<number>`
  CASE ${iacJobs.planPurpose}
    WHEN 'environment' THEN 0
    WHEN 'merge_impact' THEN 1
    ELSE 2
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
export async function findQueuedJobsForSpawning(limits: ConcurrencyLimits): Promise<SpawnResult> {
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
            runGroupId ? eq(iacJobs.runGroupId, runGroupId) : sql`${iacJobs.runGroupId} IS NULL`,
          ),
        )
        .orderBy(
          JOB_BLOCK_PRIORITY_SQL,
          JOB_PURPOSE_PRIORITY_SQL,
          JOB_TYPE_PRIORITY_SQL,
          iacJobs.queuedAt,
        )
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
      .where(and(eq(iacJobs.status, "running"), eq(workspaceDeployments.orgId, orgId)))
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
            runGroupId ? eq(iacJobs.runGroupId, runGroupId) : sql`${iacJobs.runGroupId} IS NULL`,
          ),
        )
        .orderBy(
          JOB_BLOCK_PRIORITY_SQL,
          JOB_PURPOSE_PRIORITY_SQL,
          JOB_TYPE_PRIORITY_SQL,
          iacJobs.queuedAt,
        )
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
