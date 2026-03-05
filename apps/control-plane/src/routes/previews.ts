import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { findPreviewById, listPreviews } from "../db/queries/previews.ts"
import { createApproval, listApprovals } from "../db/queries/approvals.ts"
import { logger } from "../lib/telemetry.ts"
import {
  requireOrgAccess,
  requireResourceAccess,
  getAuth,
} from "../middleware/org-auth.ts"
import { approvePreviewApply } from "../lib/webhook-handler.ts"
import { events, type PreviewUpdateEvent } from "../lib/events.ts"

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
      let pendingUpdate = false

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true
        pendingUpdate = false
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
          if (pendingUpdate) {
            await sendSnapshot()
          }
        }
      }

      // Send initial snapshot
      await sendSnapshot()

      // Listen for preview updates matching this org (and optionally repo)
      const handlePreviewUpdate = (event: PreviewUpdateEvent): void => {
        if (event.orgId === auth.orgId) {
          // If filtering by repo, only refresh when that repo changes
          if (!repo || event.repo === repo) {
            sendSnapshot().catch((err) => console.error(`[sse:previews] error in handlePreviewUpdate:`, err))
          }
        }
      }

      events.onPreviewUpdate(handlePreviewUpdate)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => { /* connection likely closed */ })
      }, 30_000)

      // Block the callback so Hono doesn't call stream.close() in its
      // finally block.  Resolves only when the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat)
          events.offPreviewUpdate(handlePreviewUpdate)
          resolve()
        })
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
        userId: a.userId,
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

    // Use auth context for approver identity
    const approverLogin = auth.name || body.data?.approverLogin
    const userId = auth.userId

    if (!userId) {
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
      approverLogin &&
      !approvers.map((a) => a.toLowerCase()).includes(approverLogin.toLowerCase())
    ) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "approver is not authorized" } },
        403,
      )
    }

    await createApproval({
      previewId: preview.id,
      userId,
      approverLogin: approverLogin ?? null,
    })

    await approvePreviewApply({
      previewId: preview.id,
      approverLogin,
    })

    return c.json({ data: { approved: true } })
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
  authorGithubId: number | null
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
  authorGithubId: number | null
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
    authorGithubId: p.authorGithubId ?? null,
    authorLogin: p.authorLogin ?? null,
    status: p.status,
    stateKey: p.stateKey,
    mode: p.mode,
    requireApproval: p.requireApproval,
    approvers,
    createdAt: p.createdAt.toISOString(),
  }
}
