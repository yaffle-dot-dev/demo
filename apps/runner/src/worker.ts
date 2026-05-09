#!/usr/bin/env node
/**
 * Yaffle Runner Worker
 *
 * A standalone worker process that:
 * 1. Claims a job atomically via API
 * 2. Fetches execution context from API
 * 3. Downloads workspace from S3
 * 4. Executes terraform via shell
 * 5. Streams logs to control plane via API
 * 6. Reports completion via API
 *
 * This worker survives control plane restarts because it runs as a detached process.
 * It has NO database access - all communication is via the Runner API.
 *
 * Environment variables:
 * - YAFFLE_JOB_ID: The job ID to execute (required)
 * - YAFFLE_JOB_TOKEN: JWT token for API authentication (required)
 * - YAFFLE_API_URL: Control plane API URL (required)
 */

import { randomUUID } from "node:crypto"

import { RunnerApiClient } from "./lib/api-client.ts"
import { runClaimedJob } from "./lib/run-claimed-job.ts"
import { error, log } from "./lib/runner-log.ts"

async function main(): Promise<void> {
  const jobId = process.env.YAFFLE_JOB_ID
  const jobToken = process.env.YAFFLE_JOB_TOKEN
  const apiUrl = process.env.YAFFLE_API_URL

  // Validate environment
  if (!jobId) {
    error("YAFFLE_JOB_ID not set")
    process.exit(1)
  }

  if (!jobToken) {
    error("YAFFLE_JOB_TOKEN not set")
    process.exit(1)
  }

  if (!apiUrl) {
    error("YAFFLE_API_URL not set")
    process.exit(1)
  }

  const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`

  log("Worker starting", { jobId, workerId, apiUrl })

  // Create API client
  const apiClient = new RunnerApiClient({
    apiUrl,
    jobToken,
    jobId,
  })

  // 1. Claim job atomically
  log("Claiming job...")
  const claimResult = await apiClient.claim(workerId)

  if (!claimResult || !claimResult.claimed) {
    // Job already claimed by another worker - exit gracefully
    log("Job already claimed, exiting gracefully")
    process.exit(0)
  }

  const runId = claimResult.runId
  if (!runId) {
    error("Claim succeeded but no runId returned")
    process.exit(1)
  }

  log("Job claimed successfully", {
    jobType: claimResult.job?.jobType,
    deploymentId: claimResult.job?.deploymentId,
    runId,
  })

  // 2. Start heartbeat supervisor
  const result = await runClaimedJob({
    apiClient,
    jobId,
    runId,
    workerId,
  })

  log("Worker exiting", { jobId, workerId, success: result.success })
  process.exit(result.success ? 0 : 1)
}

// Run main
main().catch((err) => {
  error("Unhandled exception in main", { error: String(err) })
  process.exit(1)
})
