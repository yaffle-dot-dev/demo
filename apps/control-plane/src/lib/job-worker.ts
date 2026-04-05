/**
 * Generic Job Worker
 *
 * Polls for queued jobs in the `jobs` table and dispatches them to handlers.
 * Used for background tasks like org provisioning.
 */

import { randomUUID } from "node:crypto"

import {
  claimJob,
  completeJob,
  releaseJob,
  type Job,
} from "../db/queries/jobs.ts"
import {
  handleOrgProvisionJob,
  calculateBackoffMs,
  type OrgProvisionPayload,
} from "../jobs/org-provision.ts"
import { handleProviderDiscoveryJob } from "../jobs/provider-discovery.ts"
import { logger } from "./telemetry.ts"

export interface JobWorkerConfig {
  /** How often to poll for new jobs (ms). Default: 5000 */
  pollIntervalMs?: number
}

const DEFAULT_CONFIG: Required<JobWorkerConfig> = {
  pollIntervalMs: 5000,
}

type JobWorkerState = {
  pollInterval: ReturnType<typeof setInterval> | undefined
  workerId: string | undefined
}

function getJobWorkerState(): JobWorkerState {
  const globalKey = "__yaffle_job_worker_state"
  const globalRef = globalThis as Record<string, unknown>
  if (!globalRef[globalKey]) {
    globalRef[globalKey] = {
      pollInterval: undefined,
      workerId: undefined,
    } as JobWorkerState
  }

  return globalRef[globalKey] as JobWorkerState
}

const state = getJobWorkerState()

export function getJobWorkerRuntimeInfo(): {
  workerId: string | null
  running: boolean
} {
  return {
    workerId: state.workerId ?? null,
    running: !!state.pollInterval,
  }
}

/**
 * Start the job worker.
 */
export function startJobWorker(config: JobWorkerConfig = {}): void {
  if (state.pollInterval) {
    logger.warn("Job worker already running", { workerId: state.workerId })
    return
  }

  const cfg = { ...DEFAULT_CONFIG, ...config }
  state.workerId = `job-worker-${randomUUID().slice(0, 8)}`

  logger.info("Starting job worker", { workerId: state.workerId, pollIntervalMs: cfg.pollIntervalMs })

  // Start polling
  state.pollInterval = setInterval(() => {
    pollAndProcess().catch((err) => {
      logger.error("Job worker poll error", {
        workerId: state.workerId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, cfg.pollIntervalMs)

  // Also poll immediately on start
  pollAndProcess().catch((err) => {
    logger.error("Job worker initial poll error", {
      workerId: state.workerId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * Stop the job worker.
 */
export function stopJobWorker(): void {
  if (state.pollInterval) {
    clearInterval(state.pollInterval)
    state.pollInterval = undefined
  }
  logger.info("Job worker stopped", { workerId: state.workerId })
  state.workerId = undefined
}

/**
 * Poll for a job and process it.
 */
async function pollAndProcess(): Promise<void> {
  if (!state.workerId) return

  // Try to claim a job
  const job = await claimJob(state.workerId, ["org_provision", "provider_discovery"])
  if (!job) return

  logger.info("Job claimed", {
    jobId: job.id,
    jobType: job.jobType,
    workerId: state.workerId,
    attempt: job.attempts,
  })

  try {
    await processJob(job)
    await completeJob(job.id)
    logger.info("Job completed", { jobId: job.id, jobType: job.jobType })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error("Job failed", {
      jobId: job.id,
      jobType: job.jobType,
      error: errorMessage,
      attempt: job.attempts,
    })

    // Check if we should retry or fail permanently
    // The job handler manages the retry logic via the org's provisioningAttempts
    // Here we just release the job back to pending with backoff
    const backoffMs = calculateBackoffMs(job.attempts)
    const runAt = new Date(Date.now() + backoffMs)

    await releaseJob(job.id, runAt)
    logger.info("Job released for retry", {
      jobId: job.id,
      jobType: job.jobType,
      retryAt: runAt.toISOString(),
      backoffMs,
    })
  }
}

/**
 * Process a job based on its type.
 */
async function processJob(job: Job): Promise<void> {
  switch (job.jobType) {
    case "org_provision":
      await handleOrgProvisionJob(job.payload as OrgProvisionPayload)
      break
    case "provider_discovery":
      await handleProviderDiscoveryJob(job)
      break
    default:
      throw new Error(`Unknown job type: ${job.jobType}`)
  }
}
