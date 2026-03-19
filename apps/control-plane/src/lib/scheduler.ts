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
  findQueuedJobsForSpawning,
  countActiveJobs,
  findStaleJobs,
  failStaleJob,
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

    if (result.jobs.length === 0) return

    // Record spawned jobs metric
    getSchedulerJobsClaimedCounter().add(result.jobs.length)

    logger.info("Spawning workers for jobs", {
      workerId: this.workerId,
      jobCount: result.jobs.length,
      jobIds: result.jobs.map((j) => j.id),
      totalQueued: result.totalQueued,
      groupsWithQueuedWork: result.groupsWithQueuedWork,
      blockedByGlobalLimit: result.blockedByGlobalLimit,
      blockedByGroupLimit: result.blockedByGroupLimit,
    })

    // Spawn workers for each job in parallel
    await Promise.all(
      result.jobs.map((job) => this.spawnWorker(job)),
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
 * - YAFFLE_ECS_TASK_DEFINITION: Runner task definition ARN
 * - YAFFLE_ECS_SUBNETS: Comma-separated subnet IDs
 * - YAFFLE_ECS_SECURITY_GROUPS: Comma-separated security group IDs
 * - YAFFLE_WORKSPACES_BUCKET: S3 bucket for workspace storage
 */
export async function getScheduler(): Promise<Scheduler> {
  if (schedulerInstance) {
    return schedulerInstance
  }

  // Determine which spawner to use based on environment
  const isProduction = process.env.NODE_ENV === "production"
  const useEcs = !!process.env.YAFFLE_ECS_CLUSTER

  let spawner: IacEngineSpawner
  let spawnerType: string

  if (isProduction && useEcs) {
    const { EcsEngineSpawner } = await import("./ecs-spawner.ts")
    spawner = new EcsEngineSpawner({
      clusterArn: process.env.YAFFLE_ECS_CLUSTER!,
      taskDefinition: process.env.YAFFLE_ECS_TASK_DEFINITION!,
      subnets: (process.env.YAFFLE_ECS_SUBNETS ?? "").split(",").filter(Boolean),
      securityGroups: (process.env.YAFFLE_ECS_SECURITY_GROUPS ?? "").split(",").filter(Boolean),
      workspacesBucket: process.env.YAFFLE_WORKSPACES_BUCKET!,
      region: process.env.AWS_REGION ?? "us-east-1",
    })
    spawnerType = "ecs"
    logger.info("Scheduler using ECS engine spawner")
  } else {
    // Local development: spawns detached child processes that survive CP restarts
    const { LocalChildProcessSpawner } = await import("./local-spawner.ts")
    spawner = new LocalChildProcessSpawner({
      apiUrl: process.env.YAFFLE_API_URL ?? "http://localhost:3000",
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
    spawner: spawnerType,
  })

  return schedulerInstance
}

/**
 * Start the scheduler (idempotent).
 *
 * Also runs startup recovery to fail any orphaned jobs from a previous
 * control plane instance.
 */
export async function startScheduler(): Promise<void> {
  // Run startup recovery first
  await recoverOrphanedJobs()

  const scheduler = await getScheduler()
  scheduler.start()
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop()
  }
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
