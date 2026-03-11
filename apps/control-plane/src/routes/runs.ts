import { Hono } from "hono"
import { z } from "zod"

import { findRunById, updateRunStatus } from "../db/queries/tf-runs.ts"
import { findPreviewById } from "../db/queries/previews.ts"
import { processRegistry } from "../lib/process-registry.ts"
import { logger } from "../lib/telemetry.ts"
import { requireResourceAccess, getAuth } from "../middleware/org-auth.ts"

const uuidParam = z.string().uuid()

export const runsRoute = new Hono()

// Helper to get run's orgId for resource-based auth
async function getRunOrgId(c: { req: { param: (key: string) => string | undefined } }): Promise<string | null> {
  const id = c.req.param("id")
  if (!id) return null
  const run = await findRunById(id)
  if (!run) return null
  const preview = await findPreviewById(run.previewId)
  return preview?.orgId ?? null
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
      previewId: run.previewId,
      runType: run.runType,
      userId: auth.userId,
    })

    // Try to cancel the process
    const cancelled = processRegistry.cancel(id)

    if (cancelled) {
      // Update run status to cancelled
      await updateRunStatus(id, run.previewId, "cancelled", {
        completedAt: new Date(),
        errorMessage: `Cancelled by ${auth.name || auth.userId}`,
      })

      logger.info("Run cancelled successfully", { runId: id })
      return c.json({ data: { cancelled: true } })
    }

    // Process not found in registry - might have already finished
    // or be running on a different instance (ECS)
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
        previewId: run.previewId,
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
