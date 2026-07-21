import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { RunType } from "@yaffle/shared"

import { findRunById, getRunLogSnapshot, updateRunStatus } from "../db/queries/tf-runs.ts"
import { getSpansForRun } from "../db/queries/resource-spans.ts"
import { findDeploymentById } from "../db/queries/workspace-deployments.ts"
import { cancelRunningJobForDeploymentAndType } from "../db/queries/iac-jobs.ts"

import { events, type RunUpdateEvent } from "../lib/events.ts"
import { processRegistry } from "../lib/process-registry.ts"
import {
  getRunLogConnectionsActiveCounter,
  getRunLogEventToSendLatencyHistogram,
  getRunLogMessagesSentCounter,
  getRunLogPayloadBytesHistogram,
  getRunLogStreamEndsCounter,
  logger,
} from "../lib/telemetry.ts"
import { requireResourceAccess, getAuth } from "../middleware/org-auth.ts"
import {
  buildStreamPayloadMeta,
  createStreamContext,
  parseRunViewCorrelation,
  runViewCorrelationQueryFields,
} from "../lib/run-view-monitoring.ts"

const uuidParam = z.string().uuid()
const logStreamQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).optional(),
  ...runViewCorrelationQueryFields,
})
const runOutputQuerySchema = z.object({
  ...runViewCorrelationQueryFields,
})

export const runsRoute = new Hono()

// Helper to get run's orgId for resource-based auth
async function getRunOrgId(c: {
  req: { param: (key: string) => string | undefined }
}): Promise<string | null> {
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
runsRoute.post("/:id/cancel", requireResourceAccess({ getOrgId: getRunOrgId }), async (c) => {
  const parseResult = uuidParam.safeParse(c.req.param("id"))
  if (!parseResult.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
  }
  const id = parseResult.data

  const run = await findRunById(id)
  if (!run) {
    return c.json({ error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } }, 404)
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
    const statusUpdated = await updateRunStatus(
      id,
      run.deploymentId,
      "cancelled",
      {
        completedAt: new Date(),
        errorMessage: `Cancelled by ${auth.name || auth.userId}`,
      },
      "running",
    )
    if (!statusUpdated) {
      return c.json({ error: { code: "INVALID_STATUS", message: "run is no longer running" } }, 409)
    }

    logger.info("Run cancelled successfully", { runId: id })
    return c.json({ data: { cancelled: true } })
  }

  const remoteJob =
    run.jobId && run.runGroupId
      ? await cancelRunningJobForDeploymentAndType({
          jobId: run.jobId,
          runId: run.id,
          deploymentId: run.deploymentId,
          runGroupId: run.runGroupId,
          jobType: run.runType as RunType,
          errorMessage: `Cancelled by ${auth.name || auth.userId}`,
        })
      : undefined
  if (remoteJob) {
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
        message:
          "Run process not found. It may have already completed or be running on a different instance.",
      },
    },
    404,
  )
})

/**
 * GET /api/runs/:id
 *
 * Get a run by ID.
 */
runsRoute.get("/:id", requireResourceAccess({ getOrgId: getRunOrgId }), async (c) => {
  const parseResult = uuidParam.safeParse(c.req.param("id"))
  if (!parseResult.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
  }
  const id = parseResult.data

  const run = await findRunById(id)
  if (!run) {
    return c.json({ error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } }, 404)
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
})

/**
 * GET /api/runs/:id/output
 *
 * Get the full stored log output for a run as plain text.
 */
runsRoute.get("/:id/output", requireResourceAccess({ getOrgId: getRunOrgId }), async (c) => {
  const parseResult = uuidParam.safeParse(c.req.param("id"))
  if (!parseResult.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
  }

  const queryParseResult = runOutputQuerySchema.safeParse(c.req.query())
  if (!queryParseResult.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: queryParseResult.error.issues[0]?.message ?? "invalid query",
        },
      },
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

  const correlation = parseRunViewCorrelation(queryParseResult.data)

  logger.debug("Run output fetched", {
    runId: run.id,
    deploymentId: run.deploymentId,
    runType: run.runType,
    runViewSessionId: correlation.runViewSessionId ?? undefined,
    pageViewId: correlation.pageViewId ?? undefined,
  })

  return c.text(run.logOutput ?? "")
})

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
runsRoute.get("/:id/logs", requireResourceAccess({ getOrgId: getRunOrgId }), async (c) => {
  const parseResult = uuidParam.safeParse(c.req.param("id"))
  if (!parseResult.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
  }
  const id = parseResult.data

  const queryParseResult = logStreamQuerySchema.safeParse(c.req.query())
  if (!queryParseResult.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: queryParseResult.error.issues[0]?.message ?? "invalid query",
        },
      },
      400,
    )
  }

  let lastSentOffset = queryParseResult.data.offset ?? 0
  const correlation = parseRunViewCorrelation(queryParseResult.data)

  const run = await findRunById(id)
  if (!run) {
    return c.json({ error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } }, 404)
  }

  return streamSSE(c, async (stream) => {
    const streamContext = createStreamContext("run_log", correlation)
    const metricAttrs = {
      runType: run.runType,
    }

    let latestTrigger = {
      sourceEventType: "initial",
      sourceEventAt: new Date().toISOString(),
    }

    let inFlight = false
    let pendingRefresh = false
    let finished = false

    let resolveStream: (() => void) | null = null

    getRunLogConnectionsActiveCounter().add(1, metricAttrs)
    logger.debug("Run log stream opened", {
      runId: id,
      deploymentId: run.deploymentId,
      runType: run.runType,
      streamId: streamContext.streamId,
      runViewSessionId: streamContext.runViewSessionId ?? undefined,
      pageViewId: streamContext.pageViewId ?? undefined,
      offset: lastSentOffset,
    })

    const finish = async (
      reason: "done" | "aborted" | "error" | "not_found",
      sendDone: boolean,
    ): Promise<void> => {
      if (finished) {
        return
      }

      finished = true
      clearInterval(heartbeat)
      events.offRunUpdate(handleRunUpdate)
      getRunLogConnectionsActiveCounter().add(-1, metricAttrs)
      getRunLogStreamEndsCounter().add(1, { ...metricAttrs, reason })

      logger.debug("Run log stream closed", {
        runId: id,
        deploymentId: run.deploymentId,
        runType: run.runType,
        streamId: streamContext.streamId,
        runViewSessionId: streamContext.runViewSessionId ?? undefined,
        pageViewId: streamContext.pageViewId ?? undefined,
        reason,
        offset: lastSentOffset,
        sendDone,
      })

      if (sendDone) {
        const payload = JSON.stringify({
          meta: buildStreamPayloadMeta({
            context: streamContext,
            sourceEventType: reason,
            sourceEventAt: new Date().toISOString(),
          }),
        })
        await stream.writeSSE({ event: "done", data: payload }).catch(() => {})
        getRunLogMessagesSentCounter().add(1, { ...metricAttrs, event: "done" })
        getRunLogPayloadBytesHistogram().record(payload.length, { ...metricAttrs, event: "done" })
      }

      resolveStream?.()
    }

    const requestDelta = async (trigger: {
      sourceEventType: string
      sourceEventAt: string
    }): Promise<void> => {
      latestTrigger = trigger
      await sendDelta()
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
        const trigger = latestTrigger
        const snapshot = await getRunLogSnapshot(id)
        if (!snapshot) {
          const payload = JSON.stringify({
            message: "Run not found",
            meta: buildStreamPayloadMeta({
              context: streamContext,
              sourceEventType: trigger.sourceEventType,
              sourceEventAt: trigger.sourceEventAt,
            }),
          })
          await stream
            .writeSSE({
              event: "error",
              data: payload,
            })
            .catch(() => {})
          getRunLogMessagesSentCounter().add(1, { ...metricAttrs, event: "error" })
          getRunLogPayloadBytesHistogram().record(payload.length, {
            ...metricAttrs,
            event: "error",
          })
          await finish("not_found", true)
          return
        }

        const output = snapshot.logOutput ?? ""

        if (output.length < lastSentOffset) {
          lastSentOffset = output.length
          const payload = JSON.stringify({
            output,
            meta: buildStreamPayloadMeta({
              context: streamContext,
              sourceEventType: trigger.sourceEventType,
              sourceEventAt: trigger.sourceEventAt,
            }),
          })
          await stream.writeSSE({
            event: "reset",
            data: payload,
          })
          getRunLogMessagesSentCounter().add(1, { ...metricAttrs, event: "reset" })
          getRunLogPayloadBytesHistogram().record(payload.length, {
            ...metricAttrs,
            event: "reset",
          })
        } else if (output.length > lastSentOffset) {
          const message = output.slice(lastSentOffset)
          lastSentOffset = output.length
          const payload = JSON.stringify({
            timestamp: Date.now(),
            message,
            meta: buildStreamPayloadMeta({
              context: streamContext,
              sourceEventType: trigger.sourceEventType,
              sourceEventAt: trigger.sourceEventAt,
            }),
          })
          await stream.writeSSE({
            event: "log",
            data: payload,
          })
          getRunLogMessagesSentCounter().add(1, { ...metricAttrs, event: "log" })
          getRunLogPayloadBytesHistogram().record(payload.length, { ...metricAttrs, event: "log" })

          const sourceEventMs = Date.parse(trigger.sourceEventAt)
          if (Number.isFinite(sourceEventMs)) {
            getRunLogEventToSendLatencyHistogram().record(Date.now() - sourceEventMs, {
              ...metricAttrs,
              sourceEventType: trigger.sourceEventType,
            })
          }
        }

        if (snapshot.status !== "running") {
          await finish("done", true)
        }
      } catch (err) {
        logger.error("Log streaming error", {
          runId: id,
          error: err instanceof Error ? err.message : String(err),
        })
        const payload = JSON.stringify({
          message: "Log streaming error",
          meta: buildStreamPayloadMeta({
            context: streamContext,
            sourceEventType: "stream_error",
            sourceEventAt: new Date().toISOString(),
          }),
        })
        await stream
          .writeSSE({
            event: "error",
            data: payload,
          })
          .catch(() => {})
        getRunLogMessagesSentCounter().add(1, { ...metricAttrs, event: "error" })
        getRunLogPayloadBytesHistogram().record(payload.length, { ...metricAttrs, event: "error" })
        await finish("error", true)
      } finally {
        inFlight = false
        if (pendingRefresh && !finished) {
          await sendDelta()
        }
      }
    }

    const handleRunUpdate = (event: RunUpdateEvent): void => {
      if (event.runId === id) {
        void requestDelta({
          sourceEventType: "run_update",
          sourceEventAt: event.emittedAt,
        })
      }
    }

    const initialHeartbeat = JSON.stringify({
      ts: Date.now(),
      meta: buildStreamPayloadMeta({
        context: streamContext,
        sourceEventType: "heartbeat",
        sourceEventAt: new Date().toISOString(),
      }),
    })
    await stream.writeSSE({ event: "heartbeat", data: initialHeartbeat }).catch(() => {})
    getRunLogMessagesSentCounter().add(1, { ...metricAttrs, event: "heartbeat" })
    getRunLogPayloadBytesHistogram().record(initialHeartbeat.length, {
      ...metricAttrs,
      event: "heartbeat",
    })

    const heartbeat = setInterval(() => {
      const payload = JSON.stringify({
        ts: Date.now(),
        meta: buildStreamPayloadMeta({
          context: streamContext,
          sourceEventType: "heartbeat",
          sourceEventAt: new Date().toISOString(),
        }),
      })
      stream.writeSSE({ event: "heartbeat", data: payload }).catch(() => {})
      getRunLogMessagesSentCounter().add(1, { ...metricAttrs, event: "heartbeat" })
      getRunLogPayloadBytesHistogram().record(payload.length, {
        ...metricAttrs,
        event: "heartbeat",
      })
    }, 10_000)

    events.onRunUpdate(handleRunUpdate)

    await new Promise<void>((resolve) => {
      resolveStream = resolve
      stream.onAbort(() => {
        void finish("aborted", false)
      })

      void requestDelta({
        sourceEventType: "initial",
        sourceEventAt: new Date().toISOString(),
      })
    })
  })
})

/**
 * GET /api/runs/:id/spans
 *
 * Get resource spans for a run (for Gantt chart timeline).
 */
runsRoute.get("/:id/spans", requireResourceAccess({ getOrgId: getRunOrgId }), async (c) => {
  const parseResult = uuidParam.safeParse(c.req.param("id"))
  if (!parseResult.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
  }
  const id = parseResult.data

  const run = await findRunById(id)
  if (!run) {
    return c.json({ error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } }, 404)
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
})
