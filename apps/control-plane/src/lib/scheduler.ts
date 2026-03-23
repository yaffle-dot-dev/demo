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

import postgres from "postgres"

import {
  findQueuedJobsForSpawning,
  countActiveJobs,
  findStaleJobs,
  failStaleJob,
  getJobWithContext,
  markJobBlocked,
  clearJobBlocked,
  type ConcurrencyLimits,
  type IacJob,
} from "../db/queries/iac-jobs.ts"
import { findDeploymentsReadyForAutoApply } from "../db/queries/workspace-deployments.ts"
import { queueAutoApply } from "./webhook-handler.ts"
import { generateJobTokenForJob } from "./local-spawner.ts"
import {
  getSchedulerActiveJobsGauge,
  getSchedulerGroupsQueuedGauge,
  getSchedulerJobsBlockedCounter,
  getSchedulerJobsClaimedCounter,
  getSchedulerPollDurationHistogram,
  getSchedulerPollGroupsQueriedHistogram,
  getSchedulerPollJobsFetchedHistogram,
  getSchedulerQueuedJobsGauge,
  getSchedulerSkipLockedMissesCounter,
  logger,
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
}

// Re-export spawners
export { EcsEngineSpawner } from "./ecs-spawner.ts"
export { LocalChildProcessSpawner } from "./local-spawner.ts"

export class Scheduler {
  private readonly workerId: string
  private readonly config: Required<SchedulerConfig>
  private readonly spawner: IacEngineSpawner
  private readonly limits: ConcurrencyLimits

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null
  private autoApplyTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly recentSpawnAttempts = new Map<string, number>()
  private readonly blockedJobs = new Map<string, number>()
  private lastGlobalLimitLogAtMs = 0
  private lastGroupLimitLogAtMs = 0

  constructor(spawner: IacEngineSpawner, config: SchedulerConfig = {}) {
    this.workerId = `scheduler-${randomUUID().slice(0, 8)}`
    this.spawner = spawner
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
    getSchedulerPollDurationHistogram()
    getSchedulerPollGroupsQueriedHistogram()
    getSchedulerPollJobsFetchedHistogram()
    getSchedulerSkipLockedMissesCounter()

    // Start polling for jobs
    this.pollTimer = setInterval(() => {
      this.pollForJobs().catch((err) => {
        logger.error("Job poll failed", {
          workerId: this.workerId,
          error: err instanceof Error ? err.message : String(err),
        })
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
    this.pollForAutoApplies().catch(() => {})
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

    const pollStart = performance.now()

    // Find jobs ready for spawning (does NOT claim them)
    const result = await findQueuedJobsForSpawning(this.limits)

    const pollDuration = performance.now() - pollStart
    getSchedulerPollDurationHistogram().record(pollDuration)

    this.pruneRecentSpawnAttempts()
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
      jobIds: jobsToSpawn.map((j) => j.id),
      totalQueued: result.totalQueued,
      groupsWithQueuedWork: result.groupsWithQueuedWork,
      blockedByGlobalLimit: result.blockedByGlobalLimit,
      blockedByGroupLimit: result.blockedByGroupLimit,
    })

    // Spawn workers for each job in parallel
    await Promise.all(
      jobsToSpawn.map((job) => this.spawnWorker(job)),
    )
  }

  /**
   * Spawn a worker for a single job.
   *
   * The job stays "queued" - the worker will claim it via API.
   * If spawn fails, the job remains queued for the next poll cycle.
   */
  private async spawnWorker(job: IacJob): Promise<void> {
    try {
      this.recentSpawnAttempts.set(job.id, Date.now())

      // Generate job token for this worker
      const jobToken = await generateJobTokenForJob(job.id)
      if (!jobToken) {
        logger.error("Failed to generate job token", {
          workerId: this.workerId,
          jobId: job.id,
        })
        return // Job stays queued, will be retried next poll
      }

      logger.info("Spawning worker for job", {
        workerId: this.workerId,
        jobId: job.id,
        jobType: job.jobType,
        deploymentId: job.deploymentId,
      })

      await this.spawner.spawn(job.id, jobToken)
    } catch (err) {
      logger.error("Failed to spawn worker for job", {
        workerId: this.workerId,
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })

      // Job stays "queued" - will be picked up on next poll cycle
      // This is the key improvement: no stuck "dispatched" state
    }
  }

  private shouldAttemptSpawn(jobId: string): boolean {
    const lastAttemptAt = this.recentSpawnAttempts.get(jobId)
    if (!lastAttemptAt) {
      return true
    }

    return (Date.now() - lastAttemptAt) >= this.config.spawnBackoffMs
  }

  private async filterSpawnableJobs(jobs: IacJob[]): Promise<IacJob[]> {
    const allowed: IacJob[] = []

    for (const job of jobs) {
      if (!this.shouldAttemptSpawn(job.id)) {
        continue
      }

      const blockedUntil = this.blockedJobs.get(job.id)
      if (blockedUntil && blockedUntil > Date.now()) {
        continue
      }

      const jobContext = await getJobWithContext(job.id)
      if (!jobContext?.deployment) {
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
        logger.info("Job remains queued waiting for connections", {
          jobId: job.id,
          deploymentId: job.deploymentId,
          missingProviders: resolution.missingProviders,
          conflictProviders: resolution.conflictProviders,
        })
        continue
      }

      await clearJobBlocked(job.id)

      allowed.push(job)
    }

    return allowed
  }

  private pruneRecentSpawnAttempts(): void {
    const cutoff = Date.now() - (this.config.spawnBackoffMs * 10)
    for (const [jobId, timestamp] of this.recentSpawnAttempts.entries()) {
      if (timestamp < cutoff) {
        this.recentSpawnAttempts.delete(jobId)
      }
    }
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

const SCHEDULER_LOCK_KEY_1 = 0x59414646 // "YAFF"
const SCHEDULER_LOCK_KEY_2 = 0x4c455244 // "LERD"

type SchedulerLeaderState = {
  lockClient: ReturnType<typeof postgres> | null
  hasLeadership: boolean
}

function getSchedulerLeaderState(): SchedulerLeaderState {
  const globalKey = "__yaffle_scheduler_leader_state"
  const globalRef = globalThis as Record<string, unknown>
  if (!globalRef[globalKey]) {
    globalRef[globalKey] = {
      lockClient: null,
      hasLeadership: false,
    } as SchedulerLeaderState
  }

  return globalRef[globalKey] as SchedulerLeaderState
}

const schedulerLeaderState = getSchedulerLeaderState()

async function acquireSchedulerLeadership(): Promise<boolean> {
  if (schedulerLeaderState.hasLeadership) {
    return true
  }

  const connectionString = process.env.DATABASE_URL ?? "postgresql://yaffle@localhost:5432/yaffle_dev"
  const lockClient = postgres(connectionString, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10,
  })

  try {
    const result = await lockClient<[{ acquired: boolean }]>`
      select pg_try_advisory_lock(${SCHEDULER_LOCK_KEY_1}, ${SCHEDULER_LOCK_KEY_2}) as acquired
    `

    if (!result[0]?.acquired) {
      await lockClient.end()
      return false
    }

    schedulerLeaderState.lockClient = lockClient
    schedulerLeaderState.hasLeadership = true
    return true
  } catch {
    await lockClient.end().catch(() => {})
    return false
  }
}

async function releaseSchedulerLeadership(): Promise<void> {
  if (!schedulerLeaderState.hasLeadership || !schedulerLeaderState.lockClient) {
    return
  }

  const lockClient = schedulerLeaderState.lockClient
  schedulerLeaderState.lockClient = null
  schedulerLeaderState.hasLeadership = false

  try {
    await lockClient`
      select pg_advisory_unlock(${SCHEDULER_LOCK_KEY_1}, ${SCHEDULER_LOCK_KEY_2})
    `
  } catch {
    // ignore unlock errors during shutdown
  } finally {
    await lockClient.end().catch(() => {})
  }
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
    const apiUrl = process.env.YAFFLE_RUNNER_API_URL ?? process.env.YAFFLE_API_URL

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
    const apiUrl = process.env.YAFFLE_RUNNER_API_URL ?? process.env.YAFFLE_API_URL
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
  })

  logger.info("Scheduler configured", {
    maxConcurrentJobs,
    maxJobsPerRunGroup,
    spawner: spawnerType,
  })

  return schedulerState.schedulerInstance
}

/**
 * Start the scheduler (idempotent).
 *
 * Also runs startup recovery to fail any orphaned jobs from a previous
 * control plane instance.
 */
export async function startScheduler(): Promise<void> {
  const hasLeadership = await acquireSchedulerLeadership()
  if (!hasLeadership) {
    logger.info("Scheduler leadership not acquired; skipping scheduler startup")
    return
  }

  try {
    // Run startup recovery first
    await recoverOrphanedJobs()

    const scheduler = await getScheduler()
    scheduler.start()
  } catch (err) {
    await releaseSchedulerLeadership()
    throw err
  }
}

/**
 * Stop the scheduler.
 */
export async function stopScheduler(): Promise<void> {
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
