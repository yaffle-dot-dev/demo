import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { findDeploymentById, listDeployments, pauseDeployment } from "../db/queries/workspace-deployments.ts"
import { listEnvironmentGroupProjections } from "../db/queries/environment-group-projections.ts"
import { listApprovals } from "../db/queries/approvals.ts"
import { getLatestDependencyGraphsForOrg } from "../db/queries/run-groups.ts"
import { parseEnvironmentGroupProjectionPayload } from "../lib/projections/environment-groups.ts"
import { logger } from "../lib/telemetry.ts"
import {
  requireOrgAccess,
  requireResourceAccess,
  getAuth,
} from "../middleware/org-auth.ts"
import { rerunPreview, triggerApply } from "../lib/webhook-handler.ts"
import { events, type DeploymentUpdateEvent } from "../lib/events.ts"
import { isUserAuthorizedApprover } from "../lib/approver.ts"

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

export const previewsRoute = new Hono()

interface PreviewOverviewSnapshot {
  data: ReturnType<typeof serializePreview>[]
  dependencyGraphs: Record<string, { workspaces: string[]; edges: [string, string][] }>
  nextCursor: string | null
}

async function buildPreviewOverviewSnapshot(params: {
  orgId: string
  repo?: string
  status?: z.infer<typeof listQuerySchema>["status"]
  prNumber?: number
  limit?: number
  cursor?: string
}): Promise<PreviewOverviewSnapshot> {
  const projectedGroups = await listEnvironmentGroupProjections({
    orgId: params.orgId,
    repo: params.repo,
    environmentKind: "transient",
  })

  if (projectedGroups.length > 0) {
    const filteredGroups = projectedGroups
      .map((row) => ({ row, payload: parseEnvironmentGroupProjectionPayload(row.payload) }))
      .filter((entry) => entry.payload?.environmentKind === "transient")
      .filter((entry) => {
        const payload = entry.payload!
        const prNumber = typeof payload.sourceMetadata?.prNumber === "number" ? payload.sourceMetadata.prNumber : null
        if (params.prNumber !== undefined && prNumber !== params.prNumber) {
          return false
        }
        if (params.status && payload.status !== params.status) {
          return false
        }
        if (params.cursor && payload.updatedAt >= params.cursor) {
          return false
        }
        return true
      })
      .sort((left, right) => right.payload!.updatedAt.localeCompare(left.payload!.updatedAt))

    const limitedGroups = params.limit ? filteredGroups.slice(0, params.limit) : filteredGroups
    const data = limitedGroups.flatMap((entry) => {
      const payload = entry.payload!
      const prNumber = typeof payload.sourceMetadata?.prNumber === "number" ? payload.sourceMetadata.prNumber : null

      return payload.workspaces.map((workspace) => ({
        id: workspace.deploymentId,
        repo: payload.repo,
        prNumber,
        environmentKind: payload.environmentKind,
        environmentName: payload.environmentName,
        workspacePath: workspace.workspacePath,
        ref: payload.ref,
        headSha: payload.headSha,
        authorGithubId: workspace.authorGithubId ?? payload.sourceMetadata?.authorGithubId ?? null,
        authorLogin: workspace.authorLogin ?? payload.sourceMetadata?.authorLogin ?? null,
        status: workspace.status,
        stateKey: workspace.stateKey,
        mode: workspace.mode,
        requireApproval: workspace.requireApproval,
        approvers: workspace.approvers,
        createdAt: workspace.createdAt,
      }))
    })

    const dependencyGraphs = Object.fromEntries(
      limitedGroups.flatMap((entry) => {
        const payload = entry.payload!
        return payload.dependencyGraph
          ? [[`${payload.repo}:${payload.environmentName}`, payload.dependencyGraph]]
          : []
      }),
    )

    const nextCursor = params.limit && filteredGroups.length > limitedGroups.length
      ? limitedGroups[limitedGroups.length - 1]?.payload?.updatedAt ?? null
      : null

    return {
      data,
      dependencyGraphs,
      nextCursor,
    }
  }

  const [result, dependencyGraphs] = await Promise.all([
    listDeployments(params.orgId, {
      repo: params.repo,
      status: params.status,
      prNumber: params.prNumber,
      limit: params.limit,
      cursor: params.cursor,
    }),
    getLatestDependencyGraphsForOrg(params.orgId, params.repo),
  ])

  const graphsObject: Record<string, { workspaces: string[]; edges: [string, string][] }> = {}
  for (const [key, graph] of dependencyGraphs) {
    graphsObject[key] = graph
  }

  return {
    data: result.items.map(serializePreview),
    dependencyGraphs: graphsObject,
    nextCursor: result.nextCursor,
  }
}

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

    const result = await listDeployments(auth.orgId, {
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

previewsRoute.get(
  "/overview",
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

    const snapshot = await buildPreviewOverviewSnapshot({
      orgId: auth.orgId,
      repo,
      status,
      prNumber: pr_number,
      limit,
      cursor,
    })

    return c.json(snapshot)
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
          const payload = JSON.stringify(await buildPreviewOverviewSnapshot({
            orgId: auth.orgId,
            repo,
            status,
            prNumber: pr_number,
            limit,
            cursor,
          }))

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

      // Listen for deployment updates matching this org (and optionally repo)
      const handleDeploymentUpdate = (event: DeploymentUpdateEvent): void => {
        if (event.orgId === auth.orgId) {
          // If filtering by repo, only refresh when that repo changes
          if (!repo || event.repo === repo) {
            sendSnapshot().catch((err) => console.error(`[sse:previews] error in handleDeploymentUpdate:`, err))
          }
        }
      }

      events.onDeploymentUpdate(handleDeploymentUpdate)

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
          events.offDeploymentUpdate(handleDeploymentUpdate)
          resolve()
        })
      })
    })
  },
)

// Helper to get preview orgId for resource-based auth
async function getPreviewOrgId(c: { req: { param: (key: string) => string | undefined } }): Promise<string | null> {
  const id = c.req.param("id")
  if (!id) return null
  const preview = await findDeploymentById(id)
  return preview?.orgId ?? null
}

/**
 * GET /api/previews/:id/approvals
 */
previewsRoute.get(
  "/:id/approvals",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }
    const id = parseResult.data

    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    const approvals = await listApprovals(id)

    return c.json({
      data: approvals.map((a) => ({
        id: a.id,
        deploymentId: a.deploymentId,
        userId: a.userId,
        approverLogin: a.approverLogin ?? null,
        approvedAt: a.approvedAt.toISOString(),
      })),
    })
  },
)

/**
 * POST /api/previews/:id/approve
 *
 * @deprecated Use POST /api/previews/:id/apply instead.
 * This route is kept for backwards compatibility but just redirects to triggerApply.
 */
previewsRoute.post(
  "/:id/approve",
  requireResourceAccess({ minRole: "approver", getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }
    const id = parseResult.data

    const auth = getAuth(c)

    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    // Check if user is authorized to approve
    const approverStrings = Array.isArray(preview.approvers)
      ? preview.approvers.filter((a): a is string => typeof a === "string")
      : []

    if (approverStrings.length > 0 && auth.name) {
      // installationId is required for team membership checks
      if (preview.installationId == null) {
        logger.warn("Cannot check team approvers without installationId", { previewId: id })
        return c.json(
          { error: { code: "FORBIDDEN", message: "approver is not authorized" } },
          403,
        )
      }

      const isAuthorized = await isUserAuthorizedApprover(approverStrings, {
        githubUsername: auth.name,
        installationId: preview.installationId,
      })

      if (!isAuthorized) {
        return c.json(
          { error: { code: "FORBIDDEN", message: "approver is not authorized" } },
          403,
        )
      }
    }

    // Use the single triggerApply path
    try {
      const result = await triggerApply({
        previewId: id,
        userId: auth.userId,
        approverLogin: auth.name,
      })

      return c.json({
        data: {
          approved: true,
          applyStarted: result.applyStarted,
          jobId: result.jobId,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to trigger apply"
      logger.warn("Approve/apply failed", { previewId: id, error: message })

      if (message === "no successful plan to apply") {
        return c.json({ error: { code: "NO_PLAN", message } }, 400)
      }
      if (message === "apply already in progress") {
        return c.json({ error: { code: "APPLY_IN_PROGRESS", message } }, 409)
      }
      if (message === "apply already completed") {
        return c.json({ error: { code: "ALREADY_APPLIED", message } }, 409)
      }

      return c.json({ error: { code: "APPLY_FAILED", message } }, 500)
    }
  },
)

/**
 * POST /api/previews/:id/rerun
 *
 * Manually re-run a preview (queues a plan job).
 * Useful for retrying failed runs or forcing a fresh plan.
 * The job is picked up by the scheduler and executed respecting concurrency limits.
 */
previewsRoute.post(
  "/:id/rerun",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }
    const id = parseResult.data

    const auth = getAuth(c)
    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    logger.info("Manual re-run requested", {
      previewId: id,
      userId: auth.userId,
      userName: auth.name,
    })

    try {
      const result = await rerunPreview({
        previewId: id,
        triggeredBy: auth.name || auth.userId,
      })

      return c.json({
        data: {
          rerunQueued: true,
          runGroupId: result.runGroupId,
          jobId: result.jobId,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to queue re-run"
      logger.warn("Re-run failed", {
        previewId: id,
        error: message,
      })

      // Map known errors to appropriate status codes
      if (message === "preview not found") {
        return c.json({ error: { code: "PREVIEW_NOT_FOUND", message } }, 404)
      }
      if (message === "preview has no run group") {
        return c.json({ error: { code: "NO_RUN_GROUP", message } }, 400)
      }
      if (message === "a job is already queued or running for this preview") {
        return c.json({ error: { code: "JOB_IN_PROGRESS", message } }, 409)
      }

      return c.json({ error: { code: "RERUN_FAILED", message } }, 500)
    }
  },
)

/**
 * POST /api/previews/:id/apply
 *
 * Trigger apply for a preview that has a successful plan.
 * Used by the UI for both auto-apply (countdown completed) and manual approval.
 * If the preview requires approval, records who approved it.
 */
previewsRoute.post(
  "/:id/apply",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }
    const id = parseResult.data

    const auth = getAuth(c)
    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    logger.info("Apply triggered", {
      previewId: id,
      userId: auth.userId,
      userName: auth.name,
      requireApproval: preview.requireApproval,
    })

    try {
      const result = await triggerApply({
        previewId: id,
        userId: auth.userId,
        approverLogin: auth.name,
      })

      return c.json({
        data: {
          applyStarted: result.applyStarted,
          jobId: result.jobId,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to trigger apply"
      logger.warn("Apply trigger failed", {
        previewId: id,
        error: message,
      })

      // Map known errors to appropriate status codes
      if (message === "preview not found") {
        return c.json({ error: { code: "PREVIEW_NOT_FOUND", message } }, 404)
      }
      if (message === "no successful plan to apply") {
        return c.json({ error: { code: "NO_PLAN", message } }, 400)
      }
      if (message === "apply already in progress") {
        return c.json({ error: { code: "APPLY_IN_PROGRESS", message } }, 409)
      }
      if (message === "apply already completed") {
        return c.json({ error: { code: "APPLY_COMPLETED", message } }, 409)
      }

      return c.json({ error: { code: "APPLY_FAILED", message } }, 500)
    }
  },
)

/**
 * POST /api/previews/:id/pause
 *
 * Pause auto-apply for a deployment. Transitions from awaiting_apply to awaiting_approval.
 * After pausing, the deployment requires explicit approval to apply.
 *
 * This endpoint uses CAS (compare-and-swap) to handle race conditions with the
 * server-side auto-apply scheduler. If the scheduler already transitioned the
 * deployment to applying, this endpoint returns an error.
 */
previewsRoute.post(
  "/:id/pause",
  requireResourceAccess({ getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } }, 400)
    }
    const id = parseResult.data

    const auth = getAuth(c)
    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json({ error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } }, 404)
    }

    logger.info("Pause requested", {
      previewId: id,
      userId: auth.userId,
      userName: auth.name,
      currentStatus: preview.status,
    })

    // Attempt to pause - this is atomic (CAS pattern)
    const result = await pauseDeployment(id)

    if (result.paused) {
      return c.json({
        data: {
          paused: true,
          status: "awaiting_approval",
        },
      })
    }

    // Pause failed - deployment was not in awaiting_apply state
    // Could be: already paused, already applying, already applied, etc.
    const currentPreview = await findDeploymentById(id)
    const currentStatus = currentPreview?.status ?? preview.status

    if (currentStatus === "awaiting_approval") {
      // Already paused (maybe by another request)
      return c.json({
        data: {
          paused: true,
          status: "awaiting_approval",
          message: "deployment was already paused",
        },
      })
    }

    if (currentStatus === "applying") {
      return c.json(
        { error: { code: "ALREADY_APPLYING", message: "apply already in progress, too late to pause" } },
        409,
      )
    }

    if (currentStatus === "ready") {
      return c.json(
        { error: { code: "ALREADY_APPLIED", message: "apply already completed" } },
        409,
      )
    }

    // Some other state we didn't expect
    return c.json(
      { error: { code: "INVALID_STATE", message: `cannot pause deployment in ${currentStatus} state` } },
      400,
    )
  },
)

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

interface SerializedPreview {
  id: string
  repo: string
  prNumber: number | null
  environmentKind: string
  environmentName: string
  workspacePath: string
  ref: string
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
  prNumber: number | null
  environmentKind: string
  environmentName: string
  workspacePath: string
  ref: string
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
    environmentKind: p.environmentKind,
    environmentName: p.environmentName,
    workspacePath: p.workspacePath,
    ref: p.ref,
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
