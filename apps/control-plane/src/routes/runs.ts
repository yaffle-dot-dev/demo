import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { RunType } from "@yaffle/shared"

import { findRunById, getRunLogSnapshot, updateRunStatus } from "../db/queries/tf-runs.ts"
import { getSpansForRun } from "../db/queries/resource-spans.ts"
import { findDeploymentById } from "../db/queries/workspace-deployments.ts"
import { cancelRunningJobForDeploymentAndType } from "../db/queries/iac-jobs.ts"
import { updateDeploymentStatus } from "../db/queries/workspace-deployments.ts"

import { events, type RunUpdateEvent } from "../lib/events.ts"
import { processRegistry } from "../lib/process-registry.ts"
import { logger } from "../lib/telemetry.ts"
import { requireResourceAccess, getAuth } from "../middleware/org-auth.ts"

const uuidParam = z.string().uuid()
const logStreamQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).optional(),
})

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
 * GET /api/runs/:id/output
 *
 * Get the full stored log output for a run as plain text.
 */
runsRoute.get(
  "/:id/output",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }

    const run = await findRunById(parseResult.data)
    if (!run) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `run ${parseResult.data} not found` } },
        404,
      )
    }

    return c.text(run.logOutput ?? "")
  },
)

/**
 * GET /api/runs/:id/logs
 *
 * Stream logs for a run via Server-Sent Events (SSE).
 *
 * Streams incremental log updates from the stored tf_run log buffer.
 * Use /output for the initial snapshot, then this endpoint for deltas.
 *
 * Event types:
 *   - log: A log line { timestamp, message }
 *   - reset: The stream offset is no longer valid, reload from scratch { output }
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

    const queryParseResult = logStreamQuerySchema.safeParse(c.req.query())
    if (!queryParseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: queryParseResult.error.issues[0]?.message ?? "invalid query" } },
        400,
      )
    }

    let lastSentOffset = queryParseResult.data.offset ?? 0

    const run = await findRunById(id)
    if (!run) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } },
        404,
      )
    }

    return streamSSE(c, async (stream) => {
      let inFlight = false
      let pendingRefresh = false
      let finished = false

      let resolveStream: (() => void) | null = null

      const finish = async (sendDone: boolean): Promise<void> => {
        if (finished) {
          return
        }

        finished = true
        clearInterval(heartbeat)
        events.offRunUpdate(handleRunUpdate)

        if (sendDone) {
          await stream.writeSSE({ event: "done", data: "{}" }).catch(() => {})
        }

        resolveStream?.()
      }

      const sendDelta = async (): Promise<void> => {
        if (finished) {
          return
        }

        if (inFlight) {
          pendingRefresh = true
          return
        }

        inFlight = true
        pendingRefresh = false

        try {
          const snapshot = await getRunLogSnapshot(id)
          if (!snapshot) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ message: "Run not found" }),
            }).catch(() => {})
            await finish(true)
            return
          }

          const output = snapshot.logOutput ?? ""

          if (output.length < lastSentOffset) {
            lastSentOffset = output.length
            await stream.writeSSE({
              event: "reset",
              data: JSON.stringify({ output }),
            })
          } else if (output.length > lastSentOffset) {
            const message = output.slice(lastSentOffset)
            lastSentOffset = output.length
            await stream.writeSSE({
              event: "log",
              data: JSON.stringify({
                timestamp: Date.now(),
                message,
              }),
            })
          }

          if (snapshot.status !== "running") {
            await finish(true)
          }
        } catch (err) {
          logger.error("Log streaming error", {
            runId: id,
            error: err instanceof Error ? err.message : String(err),
          })
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: "Log streaming error" }),
          }).catch(() => {})
          await finish(true)
        } finally {
          inFlight = false
          if (pendingRefresh && !finished) {
            await sendDelta()
          }
        }
      }

      const handleRunUpdate = (event: RunUpdateEvent): void => {
        if (event.runId === id) {
          void sendDelta()
        }
      }

      await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) }).catch(() => {})

      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => {})
      }, 10_000)

      events.onRunUpdate(handleRunUpdate)

      await new Promise<void>((resolve) => {
        resolveStream = resolve
        stream.onAbort(() => {
          void finish(false)
        })

        void sendDelta()
      })
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
