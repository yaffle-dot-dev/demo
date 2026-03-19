#!/usr/bin/env bun
/**
 * Yaffle Runner Worker
 *
 * A standalone worker process that:
 * 1. Claims a job atomically via API
 * 2. Sends heartbeats while executing
 * 3. Executes the terraform job
 * 4. Reports completion via API
 *
 * This worker survives control plane restarts because it runs as a detached process.
 *
 * Environment variables:
 * - YAFFLE_JOB_ID: The job ID to execute (required)
 * - YAFFLE_JOB_TOKEN: JWT token for API authentication (required)
 * - YAFFLE_API_URL: Control plane API URL (required)
 */

import { randomUUID } from "node:crypto"

import { RunnerApiClient } from "./lib/api-client.ts"
import { HeartbeatSupervisor } from "./lib/supervisor.ts"

// Required environment variables
const JOB_ID = process.env.YAFFLE_JOB_ID
const JOB_TOKEN = process.env.YAFFLE_JOB_TOKEN
const API_URL = process.env.YAFFLE_API_URL

function log(message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` ${JSON.stringify(data)}` : ""
  console.log(`[${timestamp}] [worker] ${message}${dataStr}`)
}

function error(message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` ${JSON.stringify(data)}` : ""
  console.error(`[${timestamp}] [worker] ERROR: ${message}${dataStr}`)
}

async function main(): Promise<void> {
  // Validate environment
  if (!JOB_ID) {
    error("YAFFLE_JOB_ID not set")
    process.exit(1)
  }

  if (!JOB_TOKEN) {
    error("YAFFLE_JOB_TOKEN not set")
    process.exit(1)
  }

  if (!API_URL) {
    error("YAFFLE_API_URL not set")
    process.exit(1)
  }

  const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`

  log("Worker starting", { jobId: JOB_ID, workerId, apiUrl: API_URL })

  // Create API client
  const apiClient = new RunnerApiClient({
    apiUrl: API_URL,
    jobToken: JOB_TOKEN,
    jobId: JOB_ID,
  })

  // 1. Claim job atomically
  log("Claiming job...")
  const claimResult = await apiClient.claim(workerId)

  if (!claimResult || !claimResult.claimed) {
    // Job already claimed by another worker - exit gracefully
    log("Job already claimed, exiting gracefully")
    process.exit(0)
  }

  log("Job claimed successfully", {
    jobType: claimResult.job?.jobType,
    deploymentId: claimResult.job?.deploymentId,
    workspacePath: claimResult.deployment?.workspacePath,
  })

  // 2. Start heartbeat supervisor
  const supervisor = new HeartbeatSupervisor({
    apiClient,
    onHeartbeatFailure: () => {
      error("Heartbeat supervisor detected failure, aborting")
      process.exit(1)
    },
  })

  supervisor.start()

  try {
    // 3. Execute job
    // For local development, we import and use the existing iac-engine code
    // This keeps all the terraform execution logic in one place
    const result = await executeJobWork(JOB_ID)

    // 4. Report completion
    log("Reporting completion...")

    if (result.success) {
      await apiClient.complete({
        output: result.output,
        planSummary: result.planSummary,
        planJson: result.planJson,
        outputs: result.outputs,
        durationMs: result.durationMs,
      })
      log("Job completed successfully", { durationMs: result.durationMs })
    } else {
      await apiClient.fail(result.errorMessage ?? "Unknown error")
      log("Job failed", { error: result.errorMessage })
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    error("Job execution threw exception", { error: errorMessage })

    try {
      await apiClient.fail(errorMessage)
    } catch (reportErr) {
      error("Failed to report error to API", {
        error: reportErr instanceof Error ? reportErr.message : String(reportErr),
      })
    }

    supervisor.stop()
    process.exit(1)
  }

  supervisor.stop()
  log("Worker exiting normally")
  process.exit(0)
}

interface TerraformResult {
  success: boolean
  command: "plan" | "apply" | "destroy"
  output: string
  planSummary?: string
  planJson?: unknown
  outputs?: Record<string, unknown>
  errorMessage?: string
  durationMs: number
}

/**
 * Execute the actual terraform work for a job.
 *
 * For local development, this imports and uses the existing control plane code.
 * For ECS, this would be replaced with shell-based execution.
 */
async function executeJobWork(jobId: string): Promise<TerraformResult> {
  // Import the control plane's iac-engine module
  // This keeps all terraform execution logic in one place
  const { executeJobStandalone } = await import(
    "../../control-plane/src/lib/iac-engine-standalone.ts"
  )

  return executeJobStandalone(jobId)
}

// Run main
main().catch((err) => {
  error("Unhandled exception in main", { error: String(err) })
  process.exit(1)
})
