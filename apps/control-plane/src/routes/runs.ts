import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { findPreviewById } from "../db/queries/previews.ts"
import { findRunById } from "../db/queries/tf-runs.ts"
import { requireResourceAccess } from "../middleware/org-auth.ts"
import { events, type RunUpdateEvent } from "../lib/events.ts"

const uuidParam = z.string().uuid()

export const runsRoute = new Hono()

// Helper to get org ID from run -> preview -> orgId
async function getRunOrgId(c: { req: { param: (key: string) => string } }): Promise<string | null> {
  const id = c.req.param("id")
  const run = await findRunById(id)
  if (!run) return null
  const preview = await findPreviewById(run.previewId)
  return preview?.orgId ?? null
}

/**
 * GET /api/runs/:id
 *
 * Get a single run by UUID, including status, planSummary, outputs, error, and timing.
 */
runsRoute.get(
  "/:id",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const run = await findRunById(id)
    if (!run) {
      return c.json({ error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } }, 404)
    }

    return c.json({
      data: {
        id: run.id,
        previewId: run.previewId,
        runType: run.runType,
        status: run.status,
        checkRunId: run.checkRunId,
        planSummary: run.planSummary,
        outputs: run.outputs,
        errorMessage: run.errorMessage,
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        createdAt: run.createdAt.toISOString(),
        durationMs: durationMs(run.startedAt, run.completedAt),
      },
    })
  },
)

/**
 * GET /api/runs/:id/plan
 *
 * Get the structured JSON plan for a run (from `tofu show -json`).
 * Only available for plan runs that completed successfully.
 */
runsRoute.get(
  "/:id/plan",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const run = await findRunById(id)
    if (!run) {
      return c.json({ error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } }, 404)
    }

    if (!run.planJson) {
      return c.json(
        { error: { code: "NO_PLAN", message: "no plan JSON available for this run" } },
        404,
      )
    }

    return c.json({ data: run.planJson })
  },
)

/**
 * GET /api/runs/:id/output
 *
 * Get the raw text output of a run (plan summary or error message).
 * Returns plain text, not JSON.
 */
runsRoute.get(
  "/:id/output",
  requireResourceAccess({ getOrgId: getRunOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const run = await findRunById(id)
    if (!run) {
      return c.json({ error: { code: "RUN_NOT_FOUND", message: `run ${id} not found` } }, 404)
    }

    // Return the plan summary or error message as the raw output.
    // In the future this could be the full stdout captured from the TF process.
    const output = run.logOutput ?? run.errorMessage ?? run.planSummary ?? ""

    return c.text(output)
  },
)

/**
 * GET /api/runs/:id/stream
 *
 * Server-sent events stream for run detail updates.
 */
runsRoute.get(
  "/:id/stream",
  requireResourceAccess({ getOrgId: getRunOrgId, allowQueryToken: true }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    return streamSSE(c, async (stream) => {
      let lastPayload = ""
      let inFlight = false

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) return
        inFlight = true
        try {
          const run = await findRunById(id)
          if (!run) {
            const emptyPayload = JSON.stringify({ run: null, planJson: null, output: "" })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const output = run.logOutput ?? run.errorMessage ?? run.planSummary ?? ""
          const payload = JSON.stringify({
            run: {
              id: run.id,
              previewId: run.previewId,
              runType: run.runType,
              status: run.status,
              checkRunId: run.checkRunId,
              planSummary: run.planSummary,
              outputs: run.outputs,
              errorMessage: run.errorMessage,
              logOutput: run.logOutput,
              startedAt: run.startedAt?.toISOString() ?? null,
              completedAt: run.completedAt?.toISOString() ?? null,
              createdAt: run.createdAt.toISOString(),
              durationMs: durationMs(run.startedAt, run.completedAt),
            },
            planJson: run.planJson ?? null,
            output,
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            await stream.writeSSE({ event: "update", data: payload })
          }
        } finally {
          inFlight = false
        }
      }

      // Send initial snapshot
      await sendSnapshot()

      // Listen for run updates
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        if (event.runId === id) {
          sendSnapshot()
        }
      }

      events.onRunUpdate(handleRunUpdate)

      stream.onAbort(() => {
        events.offRunUpdate(handleRunUpdate)
      })
    })
  },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function durationMs(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null
  return end.getTime() - start.getTime()
}
