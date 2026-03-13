/**
 * IaC Job Scheduler
 *
 * Polls for queued jobs and dispatches them to IaC engine instances.
 * This is the bridge between the job queue (database) and actual compute.
 *
 * Key responsibilities:
 * 1. Poll for queued jobs periodically
 * 2. Spawn IaC engine instances for claimed jobs
 * 3. Monitor job health (detect stale/dead jobs)
 * 4. Enforce concurrency limits (global and per-run-group)
 * 5. Fair round-robin scheduling across run groups
 *
 * The scheduler is stateless - all state lives in the database.
 * Multiple scheduler instances can run safely (using FOR UPDATE SKIP LOCKED).
 */

import { randomUUID } from "node:crypto"

import {
  claimQueuedJobsWithLimits,
  countActiveJobs,
  findStaleJobs,
  requeueOrFailStaleJob,
  type ConcurrencyLimits,
  type IacJob,
} from "../db/queries/iac-jobs.ts"
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

export interface SchedulerConfig {
  /** How often to poll for new jobs (ms). Default: 1000 */
  pollIntervalMs?: number
  /** How often to check for stale jobs (ms). Default: 30000 */
  staleCheckIntervalMs?: number
  /** How long without heartbeat before a job is considered stale (ms). Default: 300000 (5 min) */
  staleThresholdMs?: number
  /** Max concurrent jobs across all run groups. Default: 50 */
  maxConcurrentJobs?: number
  /** Max concurrent jobs per run group. Default: 3 */
  maxJobsPerRunGroup?: number
}

export interface IacEngineSpawner {
  /**
   * Spawn an IaC engine instance for a job.
   * The engine is responsible for:
   * 1. Fetching job details from DB
   * 2. Marking job as running
   * 3. Executing terraform
   * 4. Recording results
   * 5. Notifying downstreams
   * 6. Exiting
   *
   * @param jobId - The job ID to execute
   * @returns Promise that resolves when the engine is spawned (not when it completes)
   */
  spawn(jobId: string): Promise<void>
}

/**
 * Local development engine spawner.
 * Imports and runs the engine inline (same process).
 */
export class LocalEngineSpawner implements IacEngineSpawner {
  async spawn(jobId: string): Promise<void> {
    // Import the engine module and execute
    // This runs in the same process for local dev
    const { executeJob } = await import("./iac-engine.ts")

    // Run async but don't await - the scheduler doesn't wait for completion
    executeJob(jobId).catch((err) => {
      logger.error("Local engine execution failed", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

/**
 * Production engine spawner (ECS Fargate).
 * Spawns a container instance that runs the engine.
 */
export class EcsEngineSpawner implements IacEngineSpawner {
  private readonly clusterArn: string
  private readonly taskDefinition: string
  private readonly subnets: string[]
  private readonly securityGroups: string[]

  constructor(
    clusterArn: string,
    taskDefinition: string,
    subnets: string[],
    securityGroups: string[],
  ) {
    this.clusterArn = clusterArn
    this.taskDefinition = taskDefinition
    this.subnets = subnets
    this.securityGroups = securityGroups
  }

  async spawn(jobId: string): Promise<void> {
    // TODO: Implement ECS task spawning
    // This will use AWS SDK to run a Fargate task with the job ID as an env var
    logger.info("ECS engine spawn (not yet implemented)", {
      jobId,
      cluster: this.clusterArn,
      taskDefinition: this.taskDefinition,
      subnetCount: this.subnets.length,
      sgCount: this.securityGroups.length,
    })

    throw new Error("ECS engine spawner not yet implemented")
  }
}

export class Scheduler {
  private readonly workerId: string
  private readonly config: Required<SchedulerConfig>
  private readonly spawner: IacEngineSpawner
  private readonly limits: ConcurrencyLimits

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(spawner: IacEngineSpawner, config: SchedulerConfig = {}) {
    this.workerId = `scheduler-${randomUUID().slice(0, 8)}`
    this.spawner = spawner
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      staleCheckIntervalMs: config.staleCheckIntervalMs ?? 30000,
      staleThresholdMs: config.staleThresholdMs ?? 5 * 60 * 1000,
      maxConcurrentJobs: config.maxConcurrentJobs ?? 50,
      maxJobsPerRunGroup: config.maxJobsPerRunGroup ?? 3,
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

    // Run immediately on start
    this.pollForJobs().catch(() => {})
    this.checkStaleJobs().catch(() => {})
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
  }

  /**
   * Poll for queued jobs and dispatch them.
   * Respects concurrency limits and uses round-robin fairness across run groups.
   */
  private async pollForJobs(): Promise<void> {
    if (!this.running) return

    const pollStart = performance.now()

    // Claim jobs respecting concurrency limits
    const result = await claimQueuedJobsWithLimits(this.limits, this.workerId)

    const pollDuration = performance.now() - pollStart
    getSchedulerPollDurationHistogram().record(pollDuration)

    // Update gauge metrics
    const activeCount = await countActiveJobs()
    setSchedulerActiveJobsValue(activeCount)
    setSchedulerQueuedJobsValue(result.totalQueued - result.claimed.length)
    setSchedulerGroupsQueuedValue(result.groupsWithQueuedWork)

    // Record poll cycle metrics (for scaling analysis)
    getSchedulerPollGroupsQueriedHistogram().record(result.groupsQueried)
    getSchedulerPollJobsFetchedHistogram().record(result.jobsFetched)
    if (result.skipLockedMisses > 0) {
      getSchedulerSkipLockedMissesCounter().add(result.skipLockedMisses)
    }

    // Record blocked jobs metrics
    if (result.blockedByGlobalLimit > 0) {
      getSchedulerJobsBlockedCounter().add(result.blockedByGlobalLimit, {
        reason: "global_limit",
      })
      logger.info("Jobs blocked by global concurrency limit", {
        workerId: this.workerId,
        blocked: result.blockedByGlobalLimit,
        activeJobs: activeCount,
        maxConcurrent: this.limits.maxTotal,
      })
    }

    if (result.blockedByGroupLimit > 0) {
      getSchedulerJobsBlockedCounter().add(result.blockedByGroupLimit, {
        reason: "group_limit",
      })
      logger.info("Jobs blocked by per-group concurrency limit", {
        workerId: this.workerId,
        blocked: result.blockedByGroupLimit,
        maxPerGroup: this.limits.maxPerRunGroup,
      })
    }

    if (result.claimed.length === 0) return

    // Record claimed jobs metric
    getSchedulerJobsClaimedCounter().add(result.claimed.length)

    logger.info("Claimed jobs for dispatch", {
      workerId: this.workerId,
      jobCount: result.claimed.length,
      jobIds: result.claimed.map((j) => j.id),
      totalQueued: result.totalQueued,
      groupsWithQueuedWork: result.groupsWithQueuedWork,
      groupsQueried: result.groupsQueried,
      blockedByGlobalLimit: result.blockedByGlobalLimit,
      blockedByGroupLimit: result.blockedByGroupLimit,
    })

    // Spawn engines for each job in parallel
    await Promise.all(
      result.claimed.map((job) => this.dispatchJob(job)),
    )
  }

  /**
   * Dispatch a single job to an engine.
   */
  private async dispatchJob(job: IacJob): Promise<void> {
    try {
      logger.info("Dispatching job to engine", {
        workerId: this.workerId,
        jobId: job.id,
        jobType: job.jobType,
        previewId: job.previewId,
      })

      await this.spawner.spawn(job.id)
    } catch (err) {
      logger.error("Failed to spawn engine for job", {
        workerId: this.workerId,
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })

      // The job is in "dispatched" state but spawn failed.
      // It will be picked up by stale job detection and requeued.
    }
  }

  /**
   * Check for stale jobs (workers that died).
   */
  private async checkStaleJobs(): Promise<void> {
    if (!this.running) return

    const staleJobs = await findStaleJobs(this.config.staleThresholdMs)

    if (staleJobs.length === 0) return

    logger.warn("Found stale jobs", {
      workerId: this.workerId,
      staleJobCount: staleJobs.length,
      staleJobIds: staleJobs.map((j) => j.id),
    })

    // Requeue or fail each stale job
    for (const job of staleJobs) {
      const result = await requeueOrFailStaleJob(job.id)

      if (result.requeued) {
        logger.info("Requeued stale job", {
          workerId: this.workerId,
          jobId: job.id,
          attempts: job.attempts,
        })
      } else if (result.failed) {
        logger.error("Stale job exceeded max attempts, marked as failed", {
          workerId: this.workerId,
          jobId: job.id,
          attempts: job.attempts,
        })
      }
    }
  }
}

// =============================================================================
// Singleton scheduler instance
// =============================================================================

let schedulerInstance: Scheduler | null = null

/**
 * Get or create the scheduler instance.
 * Uses local spawner in development, ECS spawner in production.
 *
 * Configuration via environment variables:
 * - YAFFLE_MAX_CONCURRENT_JOBS: Max total concurrent jobs (default: 50 prod, 5 dev)
 * - YAFFLE_MAX_JOBS_PER_RUN_GROUP: Max concurrent jobs per run group (default: 3)
 * - YAFFLE_ECS_CLUSTER: ECS cluster ARN (enables ECS spawner in production)
 */
export function getScheduler(): Scheduler {
  if (schedulerInstance) {
    return schedulerInstance
  }

  // Determine which spawner to use based on environment
  const isProduction = process.env.NODE_ENV === "production"
  const useEcs = !!process.env.YAFFLE_ECS_CLUSTER

  let spawner: IacEngineSpawner

  if (isProduction && useEcs) {
    spawner = new EcsEngineSpawner(
      process.env.YAFFLE_ECS_CLUSTER!,
      process.env.YAFFLE_ECS_TASK_DEFINITION!,
      (process.env.YAFFLE_ECS_SUBNETS ?? "").split(",").filter(Boolean),
      (process.env.YAFFLE_ECS_SECURITY_GROUPS ?? "").split(",").filter(Boolean),
    )
    logger.info("Scheduler using ECS engine spawner")
  } else {
    spawner = new LocalEngineSpawner()
    logger.info("Scheduler using local engine spawner")
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

  schedulerInstance = new Scheduler(spawner, {
    // Faster polling in dev, slower in prod
    pollIntervalMs: isProduction ? 2000 : 500,
    staleCheckIntervalMs: isProduction ? 60000 : 30000,
    maxConcurrentJobs,
    maxJobsPerRunGroup,
  })

  logger.info("Scheduler configured", {
    maxConcurrentJobs,
    maxJobsPerRunGroup,
    spawner: useEcs ? "ecs" : "local",
  })

  return schedulerInstance
}

/**
 * Start the scheduler (idempotent).
 */
export function startScheduler(): void {
  getScheduler().start()
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop()
  }
}
