import type { ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"

import { HeartbeatSupervisor } from "./supervisor.ts"
import { cleanupWorkspace, downloadWorkspace } from "./workspace.ts"
import { executeTerraform } from "./executor.ts"
import type { ResourceSpanEvent } from "./span-parser.ts"
import type { RunnerApiClient, SpanEvent } from "./api-client.ts"
import { error, log } from "./runner-log.ts"

export async function runClaimedJob(input: {
  apiClient: RunnerApiClient
  jobId: string
  runId: string
  workerId: string
}): Promise<{ success: boolean }> {
  const { apiClient, jobId, runId, workerId } = input

  let cancellationRequested = false
  let activeProcess: ChildProcess | null = null

  const supervisor = new HeartbeatSupervisor({
    apiClient,
    onHeartbeatFailure: () => {
      cancellationRequested = true
      error("Heartbeat supervisor detected failure, signalling active tofu process", {
        jobId,
        workerId,
      })
      if (activeProcess) {
        activeProcess.kill("SIGINT")
      }
    },
  })

  supervisor.start()

  let logBuffer = ""
  let fullLogOutput = ""
  let logFlushTimer: ReturnType<typeof setTimeout> | null = null
  const LOG_FLUSH_INTERVAL = 100

  const flushLogs = async (): Promise<void> => {
    if (!logBuffer) return
    const chunk = logBuffer
    logBuffer = ""

    try {
      await apiClient.sendLogs(runId, chunk)
    } catch (err) {
      error("Failed to send logs", {
        jobId,
        workerId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const queueLog = (chunk: string, source: "stdout" | "stderr"): void => {
    const formatted = source === "stderr" ? `[stderr] ${chunk}` : chunk
    fullLogOutput += formatted
    logBuffer += formatted

    if (!logFlushTimer) {
      logFlushTimer = setTimeout(async () => {
        logFlushTimer = null
        await flushLogs()
      }, LOG_FLUSH_INTERVAL)
    }
  }

  let spanBuffer: SpanEvent[] = []
  let spanFlushTimer: ReturnType<typeof setTimeout> | null = null
  const SPAN_FLUSH_INTERVAL = 200

  const flushSpans = async (): Promise<void> => {
    if (spanBuffer.length === 0) return
    const batch = spanBuffer
    spanBuffer = []

    try {
      await apiClient.sendSpanEvents(runId, batch)
    } catch (err) {
      error("Failed to send span events", {
        jobId,
        workerId,
        error: err instanceof Error ? err.message : String(err),
        count: batch.length,
      })
    }
  }

  const queueSpanEvent = (event: ResourceSpanEvent): void => {
    spanBuffer.push({
      resourceAddress: event.resourceAddress,
      resourceType: event.resourceType,
      action: event.action,
      event: event.event,
      timestamp: event.timestamp,
      elapsedMs: event.elapsedMs,
      message: event.message,
    })

    if (!spanFlushTimer) {
      spanFlushTimer = setTimeout(async () => {
        spanFlushTimer = null
        await flushSpans()
      }, SPAN_FLUSH_INTERVAL)
    }
  }

  let workDir: string | undefined

  try {
    log("Fetching execution context...", { jobId, workerId })
    const context = await apiClient.getContext()

    log("Execution context received", {
      jobId,
      workerId,
      command: context.command,
      workspacePath: context.workspacePath,
      hasBackendConfig: !!context.backendConfig,
      variableCount: Object.keys(context.variables).length,
      executionEnvVarCount: Object.keys(context.executionEnv ?? {}).length,
      executionEnvVarKeys: Object.keys(context.executionEnv ?? {}).sort(),
    })

    log("Downloading workspace...", { jobId, workerId })
    workDir = await downloadWorkspace(context.workspaceUrl, context.workspacePath)
    log("Workspace downloaded", { jobId, workerId, workDir })

    log(`Executing tofu ${context.command}...`, { jobId, workerId })
    const result = await executeTerraform({
      workDir,
      context,
      onOutput: queueLog,
      onProcess: (proc) => {
        activeProcess = proc
        if (cancellationRequested && activeProcess) {
          activeProcess.kill("SIGINT")
        }
      },
      onSpanEvent: queueSpanEvent,
    })

    if (logFlushTimer) {
      clearTimeout(logFlushTimer)
      logFlushTimer = null
    }
    if (spanFlushTimer) {
      clearTimeout(spanFlushTimer)
      spanFlushTimer = null
    }
    await Promise.all([flushLogs(), flushSpans()])

    log("Reporting completion...", { jobId, workerId })

    if (cancellationRequested) {
      log("Job cancellation acknowledged by worker", { jobId, workerId })
      return { success: false }
    }

    if (result.success) {
      let planFileS3Key: string | undefined
      if (result.planFilePath) {
        try {
          const { uploadUrl, s3Key } = await apiClient.getPlanFileUploadUrl(runId)
          const planData = await readFile(result.planFilePath)
          await apiClient.uploadPlanFile(
            uploadUrl,
            planData.buffer.slice(
              planData.byteOffset,
              planData.byteOffset + planData.byteLength,
            ),
          )
          planFileS3Key = s3Key
          log("Plan file uploaded to S3", { jobId, workerId, s3Key })
        } catch (err) {
          error("Failed to upload plan file", {
            jobId,
            workerId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      await apiClient.complete(runId, {
        logOutput: fullLogOutput,
        output: result.output,
        hasChanges: result.hasChanges,
        planSummary: result.planSummary,
        planJson: result.planJson,
        planFileS3Key,
        outputs: result.outputs,
        durationMs: result.durationMs,
      })
      log("Job completed successfully", { jobId, workerId, durationMs: result.durationMs })
      return { success: true }
    }

    await apiClient.fail(runId, result.errorMessage ?? "Unknown error", {
      logOutput: fullLogOutput,
    })
    log("Job failed", { jobId, workerId, error: result.errorMessage })
    return { success: false }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    error("Job execution threw exception", { jobId, workerId, error: errorMessage })

    if (logFlushTimer) {
      clearTimeout(logFlushTimer)
      logFlushTimer = null
    }
    if (spanFlushTimer) {
      clearTimeout(spanFlushTimer)
      spanFlushTimer = null
    }
    await Promise.all([flushLogs(), flushSpans()])

    try {
      if (!cancellationRequested) {
        await apiClient.fail(runId, errorMessage, {
          logOutput: fullLogOutput,
        })
      }
    } catch (reportErr) {
      error("Failed to report error to API", {
        jobId,
        workerId,
        error: reportErr instanceof Error ? reportErr.message : String(reportErr),
      })
    }

    return { success: false }
  } finally {
    supervisor.stop()

    if (workDir) {
      await cleanupWorkspace(workDir)
    }
  }
}
