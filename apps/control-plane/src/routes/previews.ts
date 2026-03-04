import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { findPreviewById, listPreviews } from "../db/queries/previews.ts"
import { findLatestRun, listRunsForPreview } from "../db/queries/tf-runs.ts"
import { createApproval, listApprovals } from "../db/queries/approvals.ts"
import { logger } from "../lib/telemetry.ts"
import {
  requireOrgAccess,
  requireResourceAccess,
  getAuth,
} from "../middleware/org-auth.ts"
import { approvePreviewApply } from "../lib/webhook-handler.ts"

const listQuerySchema = z.object({
  repo: z.string().optional(),
  status: z
    .enum([
      "pending",
      "planning",
      "applying",
      "awaiting_approval",
      "ready",
      "failed",
      "destroying",
      "destroyed",
    ])
    .optional(),
  pr_number: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  cursor: z.string().datetime().optional(),
  org: z.string().min(1),
  token: z.string().optional(), // For SSE auth (EventSource can't send headers)
})

const uuidParam = z.string().uuid()
const approveSchema = z.object({
  approverLogin: z.string().min(1).optional(),
  githubUserId: z.coerce.number().int().positive().optional(),
})

export const previewsRoute = new Hono()

/**
 * GET /api/previews?org=owner&repo=owner/repo&status=ready&pr_number=42&limit=50&cursor=...
 *
 * List previews for an org. Filterable by repo, status, and PR number.
 * Cursor-based pagination — pass `nextCursor` from previous response as `cursor`.
 */
previewsRoute.get(
  "/",
  requireOrgAccess({ orgSource: "query", orgKey: "org" }),
  async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message } },
        400,
      )
    }

    const { repo, status, pr_number, limit, cursor } = parsed.data
    const auth = getAuth(c)

    const result = await listPreviews(auth.orgId, {
      repo,
      status,
      prNumber: pr_number,
      limit,
      cursor,
    })

    logger.debug("list previews", {
      orgId: auth.orgId,
      repo,
      status,
      count: result.items.length,
    })

    return c.json({
      data: result.items.map(serializePreview),
      nextCursor: result.nextCursor,
    })
  },
)

/**
 * GET /api/previews/stream?org=owner&repo=owner/repo
 *
 * Server-sent events stream for preview list updates.
 */
previewsRoute.get(
  "/stream",
  requireOrgAccess({ orgSource: "query", orgKey: "org", allowQueryToken: true }),
  async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message } },
        400,
      )
    }

    const { repo, status, pr_number, limit, cursor } = parsed.data
    const auth = getAuth(c)

    return streamSSE(c, async (stream) => {
      let lastPayload = ""
      let inFlight = false

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) return
        inFlight = true
        try {
          const result = await listPreviews(auth.orgId, {
            repo,
            status,
            prNumber: pr_number,
            limit,
            cursor,
          })

          const payload = JSON.stringify({
            data: result.items.map(serializePreview),
            nextCursor: result.nextCursor,
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            await stream.writeSSE({ event: "update", data: payload })
          }
        } finally {
          inFlight = false
        }
      }

      await sendSnapshot()

      const interval = setInterval(sendSnapshot, 5000)

      stream.onAbort(() => {
        clearInterval(interval)
      })
    })
  },
)

// Helper to get preview orgId for resource-based auth
async function getPreviewOrgId(c: { req: { param: (key: string) => string } }): Promise<string | null> {
  const id = c.req.param("id")
  const preview = await findPreviewById(id)
  return preview?.orgId ?? null
}

/**
 * GET /api/previews/:id
 *
 * Get a single preview by UUID.
 */
previewsRoute.get(
  "/:id",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const preview = await findPreviewById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    return c.json({ data: serializePreview(preview) })
  },
)

/**
 * GET /api/previews/:id/runs
 *
 * List all runs for a preview (plan, apply, destroy history).
 */
previewsRoute.get(
  "/:id/runs",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const preview = await findPreviewById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    const runs = await listRunsForPreview(id)

    return c.json({ data: runs.map(serializeRun) })
  },
)

/**
 * GET /api/previews/:id/outputs
 *
 * Get terraform outputs from the latest successful apply.
 * This is the primary endpoint for CI pipelines to get infrastructure outputs.
 */
previewsRoute.get(
  "/:id/outputs",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const preview = await findPreviewById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    const latestApply = await findLatestRun(id, "apply")
    if (!latestApply || latestApply.status !== "success" || !latestApply.outputs) {
      return c.json(
        { error: { code: "NO_OUTPUTS", message: "no successful apply with outputs found" } },
        404,
      )
    }

    return c.json({ data: latestApply.outputs })
  },
)

/**
 * GET /api/previews/:id/approvals
 */
previewsRoute.get(
  "/:id/approvals",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const preview = await findPreviewById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    const approvals = await listApprovals(id)

    return c.json({
      data: approvals.map((a) => ({
        id: a.id,
        previewId: a.previewId,
        githubUserId: a.githubUserId,
        approverLogin: a.approverLogin ?? null,
        approvedAt: a.approvedAt.toISOString(),
      })),
    })
  },
)

/**
 * POST /api/previews/:id/approve
 */
previewsRoute.post(
  "/:id/approve",
  requireResourceAccess({ minRole: "approver", getOrgId: getPreviewOrgId }),
  async (c) => {
    const id = c.req.param("id")
    const parseResult = uuidParam.safeParse(id)
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }

    const auth = getAuth(c)
    const body = approveSchema.safeParse(await c.req.json().catch(() => ({})))

    const preview = await findPreviewById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    if (preview.prNumber !== 0) {
      return c.json(
        { error: { code: "INVALID_APPROVAL", message: "only production previews require approval" } },
        400,
      )
    }

    if (!preview.requireApproval) {
      return c.json(
        { error: { code: "INVALID_APPROVAL", message: "approval not required for this preview" } },
        400,
      )
    }

    if (preview.status !== "awaiting_approval") {
      return c.json(
        { error: { code: "INVALID_STATUS", message: "preview is not awaiting approval" } },
        409,
      )
    }

    // Use auth context if available, otherwise fall back to body
    const approverLogin = auth.login || body.data?.approverLogin
    const githubUserId = auth.externalId ? Number(auth.externalId) : body.data?.githubUserId

    if (!approverLogin || !githubUserId) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "approver identity required" } },
        400,
      )
    }

    // Check if user is in the allowed approvers list (if configured)
    const approvers = Array.isArray(preview.approvers)
      ? preview.approvers.filter((a): a is string => typeof a === "string")
      : []

    if (
      approvers.length > 0 &&
      !approvers.map((a) => a.toLowerCase()).includes(approverLogin.toLowerCase())
    ) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "approver is not authorized" } },
        403,
      )
    }

    await createApproval({
      previewId: preview.id,
      githubUserId,
      approverLogin,
    })

    await approvePreviewApply({
      previewId: preview.id,
      approverLogin,
      githubUserId,
    })

    return c.json({ data: { approved: true } })
  },
)

/**
 * GET /api/previews/:id/stream
 *
 * Server-sent events stream for preview detail updates.
 */
previewsRoute.get(
  "/:id/stream",
  requireResourceAccess({ getOrgId: getPreviewOrgId, allowQueryToken: true }),
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
          const preview = await findPreviewById(id)
          if (!preview) {
            const emptyPayload = JSON.stringify({ preview: null, runs: [], outputs: null })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const runs = await listRunsForPreview(id)
          const latestApply = await findLatestRun(id, "apply")
          const outputs = latestApply?.status === "success" ? latestApply.outputs : null

          const payload = JSON.stringify({
            preview: serializePreview(preview),
            runs: runs.map(serializeRun),
            outputs,
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            await stream.writeSSE({ event: "update", data: payload })
          }
        } finally {
          inFlight = false
        }
      }

      await sendSnapshot()

      const interval = setInterval(sendSnapshot, 5000)

      stream.onAbort(() => {
        clearInterval(interval)
      })
    })
  },
)

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

interface SerializedPreview {
  id: string
  repo: string
  prNumber: number
  workspacePath: string
  branch: string
  headSha: string
  authorLogin: string | null
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  approvers: string[] | null
  createdAt: string
}

function serializePreview(p: {
  id: string
  repo: string
  prNumber: number
  workspacePath: string
  branch: string
  headSha: string
  authorLogin: string | null
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  approvers: unknown
  createdAt: Date
}): SerializedPreview {
  const approvers = Array.isArray(p.approvers)
    ? p.approvers.filter((entry) => typeof entry === "string")
    : null
  return {
    id: p.id,
    repo: p.repo,
    prNumber: p.prNumber,
    workspacePath: p.workspacePath,
    branch: p.branch,
    headSha: p.headSha,
    authorLogin: p.authorLogin ?? null,
    status: p.status,
    stateKey: p.stateKey,
    mode: p.mode,
    requireApproval: p.requireApproval,
    approvers,
    createdAt: p.createdAt.toISOString(),
  }
}

interface SerializedRun {
  id: string
  previewId: string
  runType: string
  status: string
  checkRunId: number | null
  planSummary: string | null
  outputs: unknown
  errorMessage: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

function serializeRun(r: {
  id: string
  previewId: string
  runType: string
  status: string
  checkRunId: number | null
  planSummary: string | null
  outputs: unknown
  errorMessage: string | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
}): SerializedRun {
  return {
    id: r.id,
    previewId: r.previewId,
    runType: r.runType,
    status: r.status,
    checkRunId: r.checkRunId,
    planSummary: r.planSummary,
    outputs: r.outputs,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}
