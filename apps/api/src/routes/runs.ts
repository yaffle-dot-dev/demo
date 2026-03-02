import { Hono } from "hono"
import { z } from "zod"

import { findRunById } from "../db/queries/tf-runs.ts"

const uuidParam = z.string().uuid()

export const runsRoute = new Hono()

/**
 * GET /api/runs/:id
 *
 * Get a single run by UUID, including status, planSummary, outputs, error, and timing.
 */
runsRoute.get("/:id", async (c) => {
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
})

/**
 * GET /api/runs/:id/plan
 *
 * Get the structured JSON plan for a run (from `tofu show -json`).
 * Only available for plan runs that completed successfully.
 */
runsRoute.get("/:id/plan", async (c) => {
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
})

/**
 * GET /api/runs/:id/output
 *
 * Get the raw text output of a run (plan summary or error message).
 * Returns plain text, not JSON.
 */
runsRoute.get("/:id/output", async (c) => {
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
  const output = run.errorMessage ?? run.planSummary ?? ""

  return c.text(output)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function durationMs(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null
  return end.getTime() - start.getTime()
}
