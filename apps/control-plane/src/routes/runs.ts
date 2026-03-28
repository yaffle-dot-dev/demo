import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { RunType } from "@yaffle/shared"

import { findRunById, updateRunStatus } from "../db/queries/tf-runs.ts"
import { getSpansForRun } from "../db/queries/resource-spans.ts"
import { findDeploymentById } from "../db/queries/workspace-deployments.ts"
import { cancelRunningJobForDeploymentAndType } from "../db/queries/iac-jobs.ts"
import { updateDeploymentStatus } from "../db/queries/workspace-deployments.ts"

import { processRegistry } from "../lib/process-registry.ts"
import { logger } from "../lib/telemetry.ts"
import { requireResourceAccess, getAuth } from "../middleware/org-auth.ts"
import { LogStreamer, buildLogStreamName } from "../lib/log-streamer.ts"

const uuidParam = z.string().uuid()

export const runsRoute = new Hono()

// Helper to get run's orgId for resource-based auth
async function getRunOrgId(c: { req: { param: (key: string) => string | undefined } }): Promise<string | null> {
  const id = c.req.param("id")
  if (!id) return null
  const run = await findRunById(id)
  if (!run) return null
  const deployment = await findDeploymentById(run.deploymentId)
  return deployment?.orgId ?? null
}

/**
 * POST /api/runs/:id/cancel
 *
 * Cancel a running terraform operation.
 * Sends SIGINT to the terraform process for graceful shutdown.
 */
runsRoute.post(
  "/:id/cancel",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const run = await findRunById(id)
    if (!run) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } },
        404,
      )
    }

    // Only running runs can be cancelled
    if (run.status !== "running") {
      return c.json(
        { error: { code: "INVALID_STATUS", message: `run is not running (status: ${run.status})` } },
        409,
      )
    }

    const auth = getAuth(c)
    logger.info("Cancelling run", {
      runId: id,
      deploymentId: run.deploymentId,
      runType: run.runType,
      userId: auth.userId,
    })

    // Try to cancel the process
    const cancelled = processRegistry.cancel(id)

    if (cancelled) {
      // Update run status to cancelled
      await updateRunStatus(id, run.deploymentId, "cancelled", {
        completedAt: new Date(),
        errorMessage: `Cancelled by ${auth.name || auth.userId}`,
      })

      logger.info("Run cancelled successfully", { runId: id })
      return c.json({ data: { cancelled: true } })
    }

    const remoteJob = await cancelRunningJobForDeploymentAndType(run.deploymentId, run.runType as RunType)
    if (remoteJob) {
      await updateRunStatus(id, run.deploymentId, "cancelled", {
        completedAt: new Date(),
        errorMessage: `Cancelled by ${auth.name || auth.userId}`,
      })
      await updateDeploymentStatus(run.deploymentId, "pending")

      logger.info("Run cancelled remotely", {
        runId: id,
        jobId: remoteJob.id,
        deploymentId: run.deploymentId,
      })
      return c.json({ data: { cancelled: true } })
    }

    logger.warn("Run process not found in registry", { runId: id })
    return c.json(
      {
        error: {
          code: "PROCESS_NOT_FOUND",
          message: "Run process not found. It may have already completed or be running on a different instance.",
        },
      },
      404,
    )
  },
)

/**
 * GET /api/runs/:id
 *
 * Get a run by ID.
 */
runsRoute.get(
  "/:id",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const run = await findRunById(id)
    if (!run) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } },
        404,
      )
    }

    return c.json({
      data: {
        id: run.id,
        deploymentId: run.deploymentId,
        runType: run.runType,
        status: run.status,
        planSummary: run.planSummary,
        errorMessage: run.errorMessage,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
      },
    })
  },
)

/**
 * GET /api/runs/:id/logs
 *
 * Stream logs for a run via Server-Sent Events (SSE).
 *
 * For ECS runs, this streams from CloudWatch Logs.
 * For local runs, this returns the stored log output.
 *
 * Event types:
 *   - log: A log line { timestamp, message }
 *   - error: An error occurred { message }
 *   - done: Streaming complete
 */
runsRoute.get(
  "/:id/logs",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const run = await findRunById(id)
    if (!run) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } },
        404,
      )
    }

    // Check if this is an ECS-based run
    const ecsTaskArn = run.ecsTaskArn

    if (ecsTaskArn) {
      // Stream from CloudWatch Logs
      const logGroupName = process.env.YAFFLE_RUNNER_LOG_GROUP
      if (!logGroupName) {
        return c.json(
          { error: { code: "CONFIG_ERROR", message: "Log streaming not configured" } },
          500,
        )
      }

      const logStreamName = buildLogStreamName(ecsTaskArn, "runner", "runner")
      const streamer = new LogStreamer({
        logGroupName,
        region: process.env.AWS_REGION ?? "us-east-1",
        pollIntervalMs: 1000,
      })

      logger.info("Starting log stream", {
        runId: id,
        logGroupName,
        logStreamName,
        ecsTaskArn,
      })

      return streamSSE(c, async (stream) => {
        const controller = new AbortController()

        // Clean up on disconnect
        c.req.raw.signal.addEventListener("abort", () => {
          controller.abort()
        })

        try {
          for await (const event of streamer.streamLogs(logStreamName, true, controller.signal)) {
            await stream.writeSSE({
              event: event.isError ? "error" : "log",
              data: JSON.stringify({
                timestamp: event.timestamp,
                message: event.message,
              }),
            })
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            // Normal disconnect
          } else {
            logger.error("Log streaming error", {
              runId: id,
              error: err instanceof Error ? err.message : String(err),
            })
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ message: "Log streaming error" }),
            })
          }
        }

        await stream.writeSSE({ event: "done", data: "{}" })
      })
    }

    // For non-ECS runs, return stored logs as a single event
    if (run.logOutput) {
      return streamSSE(c, async (stream) => {
        // Send existing logs as a single chunk
        await stream.writeSSE({
          event: "log",
          data: JSON.stringify({
            timestamp: run.startedAt?.getTime() ?? Date.now(),
            message: run.logOutput,
          }),
        })
        await stream.writeSSE({ event: "done", data: "{}" })
      })
    }

    // No logs available
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "log",
        data: JSON.stringify({
          timestamp: Date.now(),
          message: "No logs available for this run",
        }),
      })
      await stream.writeSSE({ event: "done", data: "{}" })
    })
  },
)

/**
 * GET /api/runs/:id/spans
 *
 * Get resource spans for a run (for Gantt chart timeline).
 */
runsRoute.get(
  "/:id/spans",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const run = await findRunById(id)
    if (!run) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } },
        404,
      )
    }

    const spans = await getSpansForRun(id)

    return c.json({
      data: spans.map((s) => ({
        id: s.id,
        resourceAddress: s.resourceAddress,
        resourceType: s.resourceType,
        action: s.action,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        durationMs: s.durationMs,
      })),
    })
  },
)
