#!/usr/bin/env bun
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
import { HeartbeatSupervisor } from "./lib/supervisor.ts"
import { downloadWorkspace, cleanupWorkspace } from "./lib/workspace.ts"
import { executeTerraform } from "./lib/executor.ts"

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
  const supervisor = new HeartbeatSupervisor({
    apiClient,
    onHeartbeatFailure: () => {
      error("Heartbeat supervisor detected failure, aborting")
      process.exit(1)
    },
  })

  supervisor.start()

  // Buffer for batching log sends
  let logBuffer = ""
  let logFlushTimer: Timer | null = null
  const LOG_FLUSH_INTERVAL = 100 // ms

  const flushLogs = async (): Promise<void> => {
    if (!logBuffer) return
    const chunk = logBuffer
    logBuffer = ""

    try {
      await apiClient.sendLogs(runId, chunk)
    } catch (err) {
      // Log locally but don't fail - logs are best-effort
      error("Failed to send logs", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const queueLog = (chunk: string, source: "stdout" | "stderr"): void => {
    const formatted = source === "stderr" ? `[stderr] ${chunk}` : chunk
    logBuffer += formatted

    // Set up periodic flushing
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(async () => {
        logFlushTimer = null
        await flushLogs()
      }, LOG_FLUSH_INTERVAL)
    }
  }

  let workDir: string | undefined

  try {
    // 3. Fetch execution context
    log("Fetching execution context...")
    const context = await apiClient.getContext()

    log("Execution context received", {
      command: context.command,
      workspacePath: context.workspacePath,
      hasBackendConfig: !!context.backendConfig,
      variableCount: Object.keys(context.variables).length,
      executionEnvVarCount: Object.keys(context.executionEnv ?? {}).length,
      executionEnvVarKeys: Object.keys(context.executionEnv ?? {}).sort(),
    })

    // 4. Download workspace from S3
    log("Downloading workspace...")
    workDir = await downloadWorkspace(context.workspaceUrl, context.workspacePath)
    log("Workspace downloaded", { workDir })

    // 5. Execute terraform
    log(`Executing tofu ${context.command}...`)
    const result = await executeTerraform({
      workDir,
      context,
      onOutput: queueLog,
    })

    // Flush any remaining logs
    if (logFlushTimer) {
      clearTimeout(logFlushTimer)
      logFlushTimer = null
    }
    await flushLogs()

    // 6. Report completion
    log("Reporting completion...")

    if (result.success) {
      await apiClient.complete(runId, {
        output: result.output,
        planSummary: result.planSummary,
        planJson: result.planJson,
        outputs: result.outputs,
        durationMs: result.durationMs,
      })
      log("Job completed successfully", { durationMs: result.durationMs })
    } else {
      await apiClient.fail(runId, result.errorMessage ?? "Unknown error")
      log("Job failed", { error: result.errorMessage })
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    error("Job execution threw exception", { error: errorMessage })

    // Flush any remaining logs
    if (logFlushTimer) {
      clearTimeout(logFlushTimer)
      logFlushTimer = null
    }
    await flushLogs()

    try {
      await apiClient.fail(runId, errorMessage)
    } catch (reportErr) {
      error("Failed to report error to API", {
        error: reportErr instanceof Error ? reportErr.message : String(reportErr),
      })
    }

    supervisor.stop()

    // Clean up workspace
    if (workDir) {
      await cleanupWorkspace(workDir)
    }

    process.exit(1)
  }

  supervisor.stop()

  // Clean up workspace
  if (workDir) {
    await cleanupWorkspace(workDir)
  }

  log("Worker exiting normally")
  process.exit(0)
}

// Run main
main().catch((err) => {
  error("Unhandled exception in main", { error: String(err) })
  process.exit(1)
})
