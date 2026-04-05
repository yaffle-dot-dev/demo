/**
 * IaC Job Scheduler
 *
 * Polls for queued jobs and spawns workers to execute them.
 * This is the bridge between the job queue (database) and actual compute.
 *
 * Key responsibilities:
 * 1. Poll for queued jobs periodically
 * 2. Generate job tokens for spawned workers
 * 3. Spawn worker processes (jobs stay queued until workers claim them)
 * 4. Monitor job health (detect stale/dead jobs)
 * 5. Enforce concurrency limits (global and per-run-group)
 * 6. Fair round-robin scheduling across run groups
 *
 * The scheduler is stateless - all state lives in the database.
 * Multiple scheduler instances can run safely (using FOR UPDATE SKIP LOCKED).
 *
 * IMPORTANT: The scheduler does NOT mark jobs as dispatched anymore.
 * Jobs go directly from "queued" to "running" when the worker claims them via API.
 * This eliminates the "dispatched but never started" failure mode.
 */

import { randomUUID } from "node:crypto"

import {
  acquireJobSpawnLease,
  findQueuedJobsForSpawning,
  countActiveJobs,
  findStaleJobs,
  failStaleJob,
  getJobWithContext,
  markJobDispatched,
  markJobBlocked,
  clearJobBlocked,
  releaseJobSpawnLease,
  type ConcurrencyLimits,
  type IacJob,
} from "../db/queries/iac-jobs.ts"
import { findDeploymentsReadyForAutoApply } from "../db/queries/workspace-deployments.ts"
import { queueAutoApply } from "./webhook-handler.ts"
import { generateJobTokenForJob } from "./local-spawner.ts"
import { acquireLease, type LeaseHandle } from "./db-lease.ts"
import {
  getSchedulerActiveJobsGauge,
  getSchedulerGroupsQueuedGauge,
  getSchedulerJobsBlockedCounter,
  getSchedulerJobsClaimedCounter,
  getSchedulerPollOverlapCounter,
  getSchedulerPollDurationHistogram,
  getSchedulerPollGroupsQueriedHistogram,
  getSchedulerPollJobsFetchedHistogram,
  getSchedulerQueuedJobsGauge,
  getSchedulerQueueToSpawnHistogram,
  getSchedulerSpawnAttemptsCounter,
  getSchedulerSpawnFailuresCounter,
  getSchedulerSpawnSuppressedCounter,
  getSchedulerSkipLockedMissesCounter,
  getRunnerDispatchDurationHistogram,
  getRunnerTasksStartedCounter,
  getRunnerWarmRunnersActiveGauge,
  getRunnerWarmSlotsActiveGauge,
  logger,
  setRunnerWarmRunnersActiveValue,
  setRunnerWarmSlotsActiveValue,
  setSchedulerActiveJobsValue,
  setSchedulerGroupsQueuedValue,
  setSchedulerQueuedJobsValue,
} from "./telemetry.ts"
import { resolveExecutionCredentialsForDeployment } from "./execution-credentials.ts"

export interface SchedulerConfig {
  /** How often to poll for new jobs (ms). Default: 1000 */
  pollIntervalMs?: number
  /** How often to check for stale jobs (ms). Default: 30000 */
  staleCheckIntervalMs?: number
  /** How often to check for auto-apply candidates (ms). Default: 5000 */
  autoApplyPollIntervalMs?: number
  /** How long without heartbeat before a job is considered stale (ms). Default: 300000 (5 min) */
  staleThresholdMs?: number
  /** Max concurrent jobs across all run groups. Default: 50 */
  maxConcurrentJobs?: number
  /** Max concurrent jobs per run group. Default: 3 */
  maxJobsPerRunGroup?: number
  /** Minimum time between spawn attempts for the same queued job in ms. Default: 120000 */
  spawnBackoffMs?: number
}

export interface IacEngineSpawner {
  /**
   * Spawn an IaC engine instance for a job.
   *
   * The spawned worker is responsible for:
   * 1. Claiming the job atomically via API (queued -> running)
   * 2. Sending heartbeats while executing
   * 3. Executing terraform
   * 4. Reporting completion via API
   * 5. Exiting
   *
   * @param jobId - The job ID to execute
   * @param jobToken - JWT token for API authentication
   * @returns Promise that resolves when the engine is spawned (not when it completes)
   */
  spawn(jobId: string, jobToken: string): Promise<void>

  /**
   * Spawn a scanner worker for dependency scanning.
   *
   * The scanner worker:
   * 1. Claims the scan job via /api/scanner/claim
   * 2. Clones the repo, reads config, scans dependencies
   * 3. Uploads workspace tarball to S3
   * 4. Reports result via /api/scanner/complete
   * 5. Exits
   */
  spawnScanner(scanJobId: string, scanToken: string): Promise<void>
}

// Re-export spawners
export { EcsEngineSpawner } from "./ecs-spawner.ts"
export { LocalChildProcessSpawner } from "./local-spawner.ts"

interface SpawnableJob {
  job: IacJob
  orgId: string
  runGroupId: string | null
  leaseToken: string
}

export class Scheduler {
  private readonly workerId: string
  private readonly config: Required<SchedulerConfig>
  readonly spawner: IacEngineSpawner
  private readonly limits: ConcurrencyLimits
  private readonly spawnerType: string

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null
  private autoApplyTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private activePollCount = 0
  private readonly blockedJobs = new Map<string, number>()
  private lastGlobalLimitLogAtMs = 0
  private lastGroupLimitLogAtMs = 0
  private consecutivePollFailures = 0
  private static readonly MAX_CONSECUTIVE_FAILURES = 5
  onAbdicate: (() => void) | null = null

  constructor(spawner: IacEngineSpawner, config: SchedulerConfig = {}, spawnerType: string = "unknown") {
    this.workerId = `scheduler-${randomUUID().slice(0, 8)}`
    this.spawner = spawner
    this.spawnerType = spawnerType
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      staleCheckIntervalMs: config.staleCheckIntervalMs ?? 30000,
      autoApplyPollIntervalMs: config.autoApplyPollIntervalMs ?? 5000,
      staleThresholdMs: config.staleThresholdMs ?? 5 * 60 * 1000,
      maxConcurrentJobs: config.maxConcurrentJobs ?? 50,
      maxJobsPerRunGroup: config.maxJobsPerRunGroup ?? 3,
      spawnBackoffMs: config.spawnBackoffMs ?? 2 * 60 * 1000,
    }
    this.limits = {
      maxTotal: this.config.maxConcurrentJobs,
      maxPerRunGroup: this.config.maxJobsPerRunGroup,
    }
  }

  /**
   * Start the scheduler.
   * Begins polling for jobs and checking for stale jobs.
   */
  start(): void {
    if (this.running) {
      logger.warn("Scheduler already running", { workerId: this.workerId })
      return
    }

    this.running = true
    logger.info("Scheduler starting", {
      workerId: this.workerId,
      pollIntervalMs: this.config.pollIntervalMs,
      staleCheckIntervalMs: this.config.staleCheckIntervalMs,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      maxJobsPerRunGroup: this.config.maxJobsPerRunGroup,
    })

    // Initialize metrics
    getSchedulerActiveJobsGauge()
    getSchedulerQueuedJobsGauge()
    getSchedulerGroupsQueuedGauge()
    getSchedulerJobsClaimedCounter()
    getSchedulerJobsBlockedCounter()
    getSchedulerSpawnAttemptsCounter()
    getSchedulerSpawnSuppressedCounter()
    getSchedulerSpawnFailuresCounter()
    getSchedulerPollOverlapCounter()
    getSchedulerPollDurationHistogram()
    getSchedulerPollGroupsQueriedHistogram()
    getSchedulerPollJobsFetchedHistogram()
    getSchedulerQueueToSpawnHistogram()
    getSchedulerSkipLockedMissesCounter()
    getRunnerDispatchDurationHistogram()
    getRunnerTasksStartedCounter()
    getRunnerWarmRunnersActiveGauge()
    getRunnerWarmSlotsActiveGauge()
    setRunnerWarmRunnersActiveValue(0)
    setRunnerWarmSlotsActiveValue(0)

    // Start polling for jobs
    this.pollTimer = setInterval(() => {
      this.pollForJobs().then(() => {
        this.consecutivePollFailures = 0
      }).catch((err) => {
        this.consecutivePollFailures++
        logger.error("Job poll failed", {
          workerId: this.workerId,
          error: err instanceof Error ? err.message : String(err),
          consecutiveFailures: this.consecutivePollFailures,
        })
        if (this.consecutivePollFailures >= Scheduler.MAX_CONSECUTIVE_FAILURES) {
          logger.error("Scheduler abdicating leadership after repeated poll failures", {
            workerId: this.workerId,
            consecutiveFailures: this.consecutivePollFailures,
          })
          this.stop()
          this.onAbdicate?.()
        }
      })
    }, this.config.pollIntervalMs)

    // Start checking for stale jobs
    this.staleCheckTimer = setInterval(() => {
      this.checkStaleJobs().catch((err) => {
        logger.error("Stale job check failed", {
          workerId: this.workerId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      this.checkStaleScanJobs().catch((err) => {
        logger.error("Stale scan job check failed", {
          workerId: this.workerId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, this.config.staleCheckIntervalMs)

    // Start checking for auto-apply candidates
    this.autoApplyTimer = setInterval(() => {
      this.pollForAutoApplies().catch((err) => {
        logger.error("Auto-apply poll failed", {
          workerId: this.workerId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, this.config.autoApplyPollIntervalMs)

    // Run immediately on start
    this.pollForJobs().catch(() => {})
    this.checkStaleJobs().catch(() => {})
    this.checkStaleScanJobs().catch(() => {})
    this.pollForAutoApplies().catch(() => {})
  }

  getWorkerId(): string {
    return this.workerId
  }

  getSpawnerType(): string {
    return this.spawnerType
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Stop the scheduler.
   * Stops polling but doesn't kill running engines.
   */
  stop(): void {
    if (!this.running) return

    this.running = false
    logger.info("Scheduler stopping", { workerId: this.workerId })

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer)
      this.staleCheckTimer = null
    }

    if (this.autoApplyTimer) {
      clearInterval(this.autoApplyTimer)
      this.autoApplyTimer = null
    }
  }

  /**
   * Poll for queued jobs and spawn workers for them.
   *
   * IMPORTANT: Jobs stay "queued" until workers claim them via API.
   * The scheduler only spawns workers - it does NOT mark jobs as dispatched.
   * This eliminates the "dispatched but never started" failure mode.
   */
  private async pollForJobs(): Promise<void> {
    if (!this.running) return

    if (this.activePollCount > 0) {
      getSchedulerPollOverlapCounter().add(1, {
        spawner: this.spawnerType,
        overlap_depth: this.activePollCount + 1,
      })
      logger.warn("Scheduler poll overlap detected", {
        workerId: this.workerId,
        activePollCount: this.activePollCount,
      })
      return
    }

    this.activePollCount++

    try {
      const pollStart = performance.now()

      // Find jobs ready for spawning (does NOT claim them)
      const result = await findQueuedJobsForSpawning(this.limits)

      const pollDuration = performance.now() - pollStart
      getSchedulerPollDurationHistogram().record(pollDuration, {
        spawner: this.spawnerType,
      })

      this.pruneBlockedJobs()

      // Update gauge metrics
      const activeCount = await countActiveJobs()
      setSchedulerActiveJobsValue(activeCount)
      setSchedulerQueuedJobsValue(result.totalQueued)
      setSchedulerGroupsQueuedValue(result.groupsWithQueuedWork)

      // Record blocked jobs metrics
      if (result.blockedByGlobalLimit > 0) {
        getSchedulerJobsBlockedCounter().add(result.blockedByGlobalLimit, {
          reason: "global_limit",
        })
        const now = Date.now()
        if (now - this.lastGlobalLimitLogAtMs >= 30000) {
          this.lastGlobalLimitLogAtMs = now
          logger.info("Jobs blocked by global concurrency limit", {
            workerId: this.workerId,
            blocked: result.blockedByGlobalLimit,
            activeJobs: activeCount,
            maxConcurrent: this.limits.maxTotal,
          })
        }
      }

      if (result.blockedByGroupLimit > 0) {
        getSchedulerJobsBlockedCounter().add(result.blockedByGroupLimit, {
          reason: "group_limit",
        })
        const now = Date.now()
        if (now - this.lastGroupLimitLogAtMs >= 30000) {
          this.lastGroupLimitLogAtMs = now
          logger.info("Jobs blocked by per-group concurrency limit", {
            workerId: this.workerId,
            blocked: result.blockedByGroupLimit,
            maxPerGroup: this.limits.maxPerRunGroup,
          })
        }
      }

      const jobsToSpawn = await this.filterSpawnableJobs(result.jobs)

      if (jobsToSpawn.length === 0) return

      // Record spawned jobs metric
      getSchedulerJobsClaimedCounter().add(jobsToSpawn.length)

      logger.info("Spawning workers for jobs", {
        workerId: this.workerId,
        jobCount: jobsToSpawn.length,
        jobIds: jobsToSpawn.map((j) => j.job.id),
        totalQueued: result.totalQueued,
        groupsWithQueuedWork: result.groupsWithQueuedWork,
        blockedByGlobalLimit: result.blockedByGlobalLimit,
        blockedByGroupLimit: result.blockedByGroupLimit,
        spawner: this.spawnerType,
      })

      // Spawn workers for each job in parallel
      await Promise.all(
        jobsToSpawn.map((job) => this.spawnWorker(job)),
      )
    } finally {
      this.activePollCount = Math.max(0, this.activePollCount - 1)
    }
  }

  /**
   * Spawn a worker for a single job.
   *
   * The job stays "queued" - the worker will claim it via API.
   * If spawn fails, the job remains queued for the next poll cycle.
   */
  private async spawnWorker(spawnableJob: SpawnableJob): Promise<void> {
    const { job, orgId, runGroupId, leaseToken } = spawnableJob
    const metricAttrs = {
      job_type: job.jobType,
      spawner: this.spawnerType,
      dispatch_mode: "burst",
    }

    try {
      getSchedulerSpawnAttemptsCounter().add(1, metricAttrs)

      const queueToSpawnMs = Date.now() - job.queuedAt.getTime()
      getSchedulerQueueToSpawnHistogram().record(queueToSpawnMs, metricAttrs)

      // Generate job token for this worker
      const jobToken = await generateJobTokenForJob(job.id, leaseToken)
      if (!jobToken) {
        await releaseJobSpawnLease(job.id, leaseToken)
        getSchedulerSpawnFailuresCounter().add(1, {
          ...metricAttrs,
          reason: "job_token_generation",
        })
        logger.error("Failed to generate job token", {
          workerId: this.workerId,
          jobId: job.id,
          orgId,
        })
        return // Job stays queued, will be retried next poll
      }

      logger.info("Spawning worker for job", {
        workerId: this.workerId,
        jobId: job.id,
        jobType: job.jobType,
        deploymentId: job.deploymentId,
        orgId,
        runGroupId: runGroupId ?? undefined,
        queueToSpawnMs,
        spawner: this.spawnerType,
        dispatchMode: "burst",
      })

      const dispatchStart = performance.now()
      await this.spawner.spawn(job.id, jobToken)
      const dispatchDurationMs = performance.now() - dispatchStart

      getRunnerDispatchDurationHistogram().record(dispatchDurationMs, metricAttrs)
      getRunnerTasksStartedCounter().add(1, metricAttrs)

      try {
        await markJobDispatched(job.id, leaseToken)
      } catch (err) {
        logger.error("Failed to record dispatched timestamp for job", {
          workerId: this.workerId,
          jobId: job.id,
          orgId,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      logger.info("Worker spawn accepted", {
        workerId: this.workerId,
        jobId: job.id,
        jobType: job.jobType,
        deploymentId: job.deploymentId,
        orgId,
        runGroupId: runGroupId ?? undefined,
        spawner: this.spawnerType,
        dispatchMode: "burst",
        "duration.queue_to_spawn_ms": queueToSpawnMs,
        "duration.dispatch_ms": dispatchDurationMs,
      })
    } catch (err) {
      getSchedulerSpawnFailuresCounter().add(1, {
        ...metricAttrs,
        reason: "spawn_error",
      })
      logger.error("Failed to spawn worker for job", {
        workerId: this.workerId,
        jobId: job.id,
        orgId,
        error: err instanceof Error ? err.message : String(err),
      })

      // Keep the lease until expiry on ambiguous spawn errors. This avoids
      // duplicate dispatch when the underlying runner start may have succeeded
      // but the control plane did not get a clean acknowledgement.
    }
  }

  private async filterSpawnableJobs(jobs: IacJob[]): Promise<SpawnableJob[]> {
    const allowed: SpawnableJob[] = []

    for (const job of jobs) {
      const blockedUntil = this.blockedJobs.get(job.id)
      if (blockedUntil && blockedUntil > Date.now()) {
        getSchedulerSpawnSuppressedCounter().add(1, {
          reason: "blocked_waiting_for_connections",
          job_type: job.jobType,
          spawner: this.spawnerType,
        })
        continue
      }

      const jobContext = await getJobWithContext(job.id)
      if (!jobContext?.deployment) {
        getSchedulerSpawnSuppressedCounter().add(1, {
          reason: "missing_job_context",
          job_type: job.jobType,
          spawner: this.spawnerType,
        })
        continue
      }

      const lease = await acquireJobSpawnLease(
        job.id,
        this.workerId,
        this.config.spawnBackoffMs,
      )
      if (!lease.acquired || !lease.leaseToken) {
        getSchedulerSpawnSuppressedCounter().add(1, {
          reason: "active_spawn_lease",
          job_type: job.jobType,
          spawner: this.spawnerType,
        })
        continue
      }

      const resolution = await resolveExecutionCredentialsForDeployment(jobContext.deployment)
      if (!resolution.ok) {
        const parts: string[] = []
        if (resolution.missingProviders.length > 0) {
          parts.push(`Missing connections: ${resolution.missingProviders.join(", ")}`)
        }
        if (resolution.conflictProviders.length > 0) {
          parts.push(`Conflicting connections: ${resolution.conflictProviders.join(", ")}`)
        }
        const reason = parts.join("; ")

        this.blockedJobs.set(job.id, Date.now() + 30_000)
        await markJobBlocked(job.id, reason)
        await releaseJobSpawnLease(job.id, lease.leaseToken)
        getSchedulerSpawnSuppressedCounter().add(1, {
          reason: "connections_not_ready",
          job_type: job.jobType,
          spawner: this.spawnerType,
        })
        logger.info("Job remains queued waiting for connections", {
          jobId: job.id,
          deploymentId: job.deploymentId,
          orgId: jobContext.deployment.orgId,
          missingProviders: resolution.missingProviders,
          conflictProviders: resolution.conflictProviders,
        })
        continue
      }

      await clearJobBlocked(job.id)

      allowed.push({
        job,
        orgId: jobContext.deployment.orgId,
        runGroupId: jobContext.deployment.runGroupId,
        leaseToken: lease.leaseToken,
      })
    }

    return allowed
  }

  private pruneBlockedJobs(): void {
    const now = Date.now()
    for (const [jobId, blockedUntil] of this.blockedJobs.entries()) {
      if (blockedUntil <= now) {
        this.blockedJobs.delete(jobId)
      }
    }
  }

  /**
   * Check for stale jobs (workers that stopped heartbeating).
   * 
   * We mark these as failed rather than requeuing because:
   * 1. Terraform operations can legitimately take 10+ minutes
   * 2. Auto-requeuing causes duplicate runs and state lock conflicts
   * 3. It's safer to fail and let humans investigate/retry
   */
  private async checkStaleJobs(): Promise<void> {
    if (!this.running) return

    const staleJobs = await findStaleJobs(this.config.staleThresholdMs)

    if (staleJobs.length === 0) return

    logger.warn("Found stale jobs (will mark as failed)", {
      workerId: this.workerId,
      staleJobCount: staleJobs.length,
      staleJobIds: staleJobs.map((j) => j.id),
    })

    for (const job of staleJobs) {
      const result = await failStaleJob(job.id)

      if (result.failed) {
        logger.error("Marked stale job as failed", {
          workerId: this.workerId,
          jobId: job.id,
          lastHeartbeat: job.lastHeartbeat?.toISOString() ?? "never",
        })
      }
    }
  }

  /**
   * Check for stale scan jobs (scanner workers that stopped heartbeating).
   */
  private async checkStaleScanJobs(): Promise<void> {
    if (!this.running) return

    const { findStaleScanJobs, failScanJob } = await import("../db/queries/scan-jobs.ts")
    const { updateRunGroupStatus } = await import("../db/queries/run-groups.ts")

    // Scans should complete in seconds — use 60s threshold so users don't
    // stare at a spinner. See YAF-131 for the real event-driven fix.
    const scanStaleThresholdMs = Math.min(this.config.staleThresholdMs, 60_000)
    const staleScanJobs = await findStaleScanJobs(scanStaleThresholdMs)

    if (staleScanJobs.length === 0) return

    logger.warn("Found stale scan jobs (will mark as failed)", {
      workerId: this.workerId,
      staleScanJobCount: staleScanJobs.length,
    })

    for (const job of staleScanJobs) {
      await failScanJob(job.id, "Scanner worker stopped responding (stale heartbeat)")
      await updateRunGroupStatus(job.runGroupId, "failed", { completedAt: new Date() })

      logger.error("Marked stale scan job as failed", {
        workerId: this.workerId,
        scanJobId: job.id,
        runGroupId: job.runGroupId,
        lastHeartbeat: job.lastHeartbeat?.toISOString() ?? "never",
      })
    }
  }

  /**
   * Poll for deployments ready for auto-apply.
   * These are deployments in 'awaiting_apply' state that:
   * - Don't require approval
   * - Have been waiting for at least 30 seconds (to allow pause opportunity)
   */
  private async pollForAutoApplies(): Promise<void> {
    if (!this.running) return

    const deployments = await findDeploymentsReadyForAutoApply()

    if (deployments.length === 0) return

    logger.info("Found deployments ready for auto-apply", {
      workerId: this.workerId,
      count: deployments.length,
      deploymentIds: deployments.map((d) => d.id),
    })

    // Queue apply jobs for each deployment
    // These run through queueAutoApply which handles CAS/race conditions
    for (const deployment of deployments) {
      try {
        const result = await queueAutoApply(deployment.id)
        if (result) {
          logger.info("Auto-apply job queued", {
            workerId: this.workerId,
            deploymentId: deployment.id,
            jobId: result.jobId,
            workspacePath: deployment.workspacePath,
          })
        }
      } catch (err) {
        logger.error("Failed to queue auto-apply", {
          workerId: this.workerId,
          deploymentId: deployment.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}

/** Lease duration — if the leader doesn't renew within this window, it's dead */
const SCHEDULER_LEASE_TTL_MS = 15_000
const SCHEDULER_LEASE_KEY = "scheduler:leader"

type SchedulerLeaderState = {
  holderId: string
  leaseHandle: LeaseHandle | null
  electionTimer: ReturnType<typeof setInterval> | null
  abdicatedAt: number | null
}

function getSchedulerLeaderState(): SchedulerLeaderState {
  const globalKey = "__yaffle_scheduler_leader_state"
  const globalRef = globalThis as Record<string, unknown>
  if (!globalRef[globalKey]) {
    globalRef[globalKey] = {
      holderId: `scheduler-${randomUUID().slice(0, 8)}`,
      leaseHandle: null,
      electionTimer: null,
      abdicatedAt: null,
    } as SchedulerLeaderState
  }

  return globalRef[globalKey] as SchedulerLeaderState
}

const schedulerLeaderState = getSchedulerLeaderState()

async function acquireSchedulerLeadership(): Promise<boolean> {
  if (schedulerLeaderState.leaseHandle) {
    return true
  }

  const handle = await acquireLease(
    SCHEDULER_LEASE_KEY,
    schedulerLeaderState.holderId,
    SCHEDULER_LEASE_TTL_MS,
  )

  if (!handle) {
    logger.info("Scheduler leadership held by another instance")
    return false
  }

  schedulerLeaderState.leaseHandle = handle
  return true
}

async function releaseSchedulerLeadership(): Promise<void> {
  if (!schedulerLeaderState.leaseHandle) {
    return
  }

  const handle = schedulerLeaderState.leaseHandle
  schedulerLeaderState.leaseHandle = null
  await handle.release()
}

// =============================================================================
// Singleton scheduler instance
// =============================================================================

type SchedulerGlobalState = {
  schedulerInstance: Scheduler | null
}

function getSchedulerGlobalState(): SchedulerGlobalState {
  const globalKey = "__yaffle_scheduler_state"
  const globalRef = globalThis as Record<string, unknown>
  if (!globalRef[globalKey]) {
    globalRef[globalKey] = {
      schedulerInstance: null,
    } as SchedulerGlobalState
  }

  return globalRef[globalKey] as SchedulerGlobalState
}

const schedulerState = getSchedulerGlobalState()

type SchedulerRuntimeLike = {
  getWorkerId?: () => string
  getSpawnerType?: () => string
  isRunning?: () => boolean
  workerId?: string
  spawnerType?: string
  running?: boolean
}

export function getSchedulerRuntimeInfo(): {
  workerId: string | null
  spawnerType: string | null
  isLeader: boolean
  isRunning: boolean
  electionRunning: boolean
} {
  const scheduler = schedulerState.schedulerInstance as SchedulerRuntimeLike | null
  const workerId = typeof scheduler?.getWorkerId === "function"
    ? scheduler.getWorkerId()
    : typeof scheduler?.workerId === "string"
      ? scheduler.workerId
      : null
  const spawnerType = typeof scheduler?.getSpawnerType === "function"
    ? scheduler.getSpawnerType()
    : typeof scheduler?.spawnerType === "string"
      ? scheduler.spawnerType
      : null
  const isRunning = typeof scheduler?.isRunning === "function"
    ? scheduler.isRunning()
    : typeof scheduler?.running === "boolean"
      ? scheduler.running
      : false

  return {
    workerId,
    spawnerType,
    isLeader: !!schedulerLeaderState.leaseHandle,
    isRunning,
    electionRunning: !!schedulerLeaderState.electionTimer,
  }
}

/**
 * Get or create the scheduler instance.
 * Uses local spawner in development, ECS spawner in production.
 *
 * Configuration via environment variables:
 * - YAFFLE_MAX_CONCURRENT_JOBS: Max total concurrent jobs (default: 50 prod, 5 dev)
 * - YAFFLE_MAX_JOBS_PER_RUN_GROUP: Max concurrent jobs per run group (default: 3)
 * - YAFFLE_ECS_CLUSTER: ECS cluster ARN
 * - YAFFLE_ECS_TASK_DEFINITION: Runner task definition ARN
 * - YAFFLE_ECS_SUBNETS: Comma-separated subnet IDs
 * - YAFFLE_ECS_SECURITY_GROUPS: Comma-separated security group IDs
 * - YAFFLE_USE_ECS_RUNNER: Set to "true" to force ECS spawner in development
 */
export async function getScheduler(): Promise<Scheduler> {
  if (schedulerState.schedulerInstance) {
    return schedulerState.schedulerInstance
  }

  // Determine which spawner to use based on environment
  const isProduction = process.env.NODE_ENV === "production"
  const useEcs = !!process.env.YAFFLE_ECS_CLUSTER
  const forceEcs = process.env.YAFFLE_USE_ECS_RUNNER === "true"

  let spawner: IacEngineSpawner
  let spawnerType: string

  if ((isProduction || forceEcs) && useEcs) {
    const { EcsEngineSpawner } = await import("./ecs-spawner.ts")

    const clusterArn = process.env.YAFFLE_ECS_CLUSTER
    const taskDefinition = process.env.YAFFLE_ECS_TASK_DEFINITION
    const subnets = (process.env.YAFFLE_ECS_SUBNETS ?? "").split(",").filter(Boolean)
    const securityGroups = (process.env.YAFFLE_ECS_SECURITY_GROUPS ?? "").split(",").filter(Boolean)
    const apiUrl = process.env.YAFFLE_RUNNER_API_URL

    if (!clusterArn || !taskDefinition || subnets.length === 0 || securityGroups.length === 0 || !apiUrl) {
      throw new Error("Missing ECS spawner configuration (cluster/task/subnets/sg/apiUrl)")
    }

    spawner = new EcsEngineSpawner({
      clusterArn,
      taskDefinition,
      subnets,
      securityGroups,
      region: process.env.AWS_REGION ?? "us-east-1",
      apiUrl,
    })
    spawnerType = "ecs"
    logger.info("Scheduler using ECS engine spawner")
  } else {
    // Local development: spawns detached child processes that survive CP restarts
    const apiUrl = process.env.YAFFLE_RUNNER_API_URL
    if (!apiUrl) {
      throw new Error("YAFFLE_RUNNER_API_URL must be configured")
    }

    const { LocalChildProcessSpawner } = await import("./local-spawner.ts")
    spawner = new LocalChildProcessSpawner({
      apiUrl,
    })
    spawnerType = "local"
    logger.info("Scheduler using local spawner (child process)")
  }

  // Parse concurrency limits from environment
  const defaultMaxConcurrent = isProduction ? 50 : 5
  const maxConcurrentJobs = parseInt(
    process.env.YAFFLE_MAX_CONCURRENT_JOBS ?? String(defaultMaxConcurrent),
    10,
  )
  const maxJobsPerRunGroup = parseInt(
    process.env.YAFFLE_MAX_JOBS_PER_RUN_GROUP ?? "3",
    10,
  )

  schedulerState.schedulerInstance = new Scheduler(spawner, {
    // Faster polling in dev, slower in prod
    pollIntervalMs: isProduction ? 2000 : 500,
    staleCheckIntervalMs: isProduction ? 60000 : 30000,
    maxConcurrentJobs,
    maxJobsPerRunGroup,
  }, spawnerType)

  logger.info("Scheduler configured", {
    maxConcurrentJobs,
    maxJobsPerRunGroup,
    spawner: spawnerType,
  })

  return schedulerState.schedulerInstance
}

/** How often a non-leader instance retries acquiring the lock */
const LEADER_ELECTION_INTERVAL_MS = 5_000
/** How long to wait after abdication before trying to reclaim leadership */
const ABDICATION_COOLDOWN_MS = 60_000

/**
 * Start the scheduler with continuous leader election.
 *
 * Tries to acquire the lease immediately. If it fails, retries every
 * 5 seconds. When leadership is acquired, runs orphan recovery and starts
 * the scheduler. If the scheduler abdicates (repeated failures), releases
 * the lease and waits a cooldown period before retrying.
 */
export async function startScheduler(): Promise<void> {
  // Try immediately
  await tryBecomeLeader()

  // Then keep trying on an interval (no-ops if already leader)
  schedulerLeaderState.electionTimer = setInterval(() => {
    tryBecomeLeader().catch((err) => {
      logger.error("Leader election tick failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, LEADER_ELECTION_INTERVAL_MS)
}

async function tryBecomeLeader(): Promise<void> {
  if (schedulerLeaderState.leaseHandle) {
    return
  }

  // Respect abdication cooldown — don't reclaim immediately after failing
  if (schedulerLeaderState.abdicatedAt) {
    const elapsed = Date.now() - schedulerLeaderState.abdicatedAt
    if (elapsed < ABDICATION_COOLDOWN_MS) {
      return
    }
    logger.info("Abdication cooldown expired, eligible to reclaim leadership")
    schedulerLeaderState.abdicatedAt = null
  }

  const acquired = await acquireSchedulerLeadership()
  if (!acquired) {
    return
  }

  logger.info("Scheduler leadership acquired, starting scheduler")

  try {
    await recoverOrphanedJobs()
    const scheduler = await getScheduler()
    scheduler.onAbdicate = () => {
      logger.warn("Scheduler abdicated, releasing leadership")
      schedulerLeaderState.abdicatedAt = Date.now()
      releaseSchedulerLeadership().catch(() => {})
    }
    scheduler.start()
  } catch (err) {
    logger.error("Failed to start scheduler after acquiring leadership", {
      error: err instanceof Error ? err.message : String(err),
    })
    await releaseSchedulerLeadership()
  }
}

/**
 * Stop the scheduler and leader election.
 */
export async function stopScheduler(): Promise<void> {
  if (schedulerLeaderState.electionTimer) {
    clearInterval(schedulerLeaderState.electionTimer)
    schedulerLeaderState.electionTimer = null
  }

  if (schedulerState.schedulerInstance) {
    schedulerState.schedulerInstance.stop()
  }

  await releaseSchedulerLeadership()
}

/**
 * Recover orphaned jobs on control plane startup.
 *
 * Jobs may be orphaned if:
 * - The control plane crashed while jobs were running
 * - Workers died without reporting completion
 * - Workers can't reach the API to report completion
 *
 * We mark these jobs as failed rather than requeuing because:
 * - Terraform state may be inconsistent
 * - Auto-requeuing can cause duplicate runs
 * - It's safer to fail and let humans investigate/retry
 */
async function recoverOrphanedJobs(): Promise<void> {
  logger.info("Running startup recovery for orphaned jobs")

  // Find jobs that are in "running" state with stale heartbeats
  // These are jobs where the worker likely died
  const staleJobs = await findStaleJobs(5 * 60 * 1000) // 5 minute threshold

  if (staleJobs.length === 0) {
    logger.info("No orphaned jobs found during startup recovery")
    return
  }

  logger.warn("Found orphaned jobs during startup recovery", {
    count: staleJobs.length,
    jobIds: staleJobs.map((j) => j.id),
  })

  for (const job of staleJobs) {
    const result = await failStaleJob(job.id)

    if (result.failed) {
      logger.info("Marked orphaned job as failed during startup recovery", {
        jobId: job.id,
        lastHeartbeat: job.lastHeartbeat?.toISOString() ?? "never",
        startedAt: job.startedAt?.toISOString(),
      })
    }
  }

  logger.info("Startup recovery complete", {
    failedCount: staleJobs.length,
  })
}
