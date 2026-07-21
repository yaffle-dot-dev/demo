import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { findDeploymentById, listDeployments } from "../db/queries/workspace-deployments.ts"
import { listEnvironmentGroupProjections } from "../db/queries/environment-group-projections.ts"
import { listApprovals } from "../db/queries/approvals.ts"
import {
  findRunGroupsByIds,
  getLatestDependencyGraphsForOrg,
  type RunGroupWithRepoBinding,
} from "../db/queries/run-groups.ts"
import { parseEnvironmentGroupProjectionPayload } from "../lib/projections/environment-groups.ts"
import { logger } from "../lib/telemetry.ts"
import { requireOrgAccess, requireResourceAccess, getAuth } from "../middleware/org-auth.ts"
import { pausePreview, rerunPreview, triggerApply } from "../lib/webhook-handler.ts"
import { events, type DeploymentUpdateEvent } from "../lib/events.ts"
import {
  ExecutionMutationDeniedError,
  type ExecutionMutationActor,
} from "../lib/execution-mutation.ts"
import {
  isExecutionContextAssociationValid,
  serializeBoundExecutionSnapshotIdentity,
} from "../lib/execution-snapshot.ts"

const listQuerySchema = z.object({
  repo: z.string().optional(),
  status: z
    .enum([
      "pending",
      "planning",
      "applying",
      "activating",
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

  if (projectedGroups.length > 0 && projectedGroups.every((row) => row.version >= 2)) {
    const filteredGroups = projectedGroups
      .map((row) => ({ row, payload: parseEnvironmentGroupProjectionPayload(row.payload) }))
      .filter((entry) => entry.payload?.environmentKind === "transient")
      .filter((entry) => {
        const payload = entry.payload!
        const prNumber =
          typeof payload.sourceMetadata?.prNumber === "number"
            ? payload.sourceMetadata.prNumber
            : null
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
    const runGroupsById = await findRunGroupsByIds(
      limitedGroups.flatMap((entry) =>
        entry.payload!.workspaces.flatMap((workspace) =>
          workspace.runGroupId ? [workspace.runGroupId] : [],
        ),
      ),
      params.orgId,
    )
    const data = limitedGroups.flatMap((entry) => {
      const payload = entry.payload!
      const prNumber =
        typeof payload.sourceMetadata?.prNumber === "number"
          ? payload.sourceMetadata.prNumber
          : null

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
        headUpdatedAt: workspace.headUpdatedAt,
        executionContext: serializePreviewExecutionContext(
          {
            orgId: params.orgId,
            repo: payload.repo,
            environmentKind: payload.environmentKind,
            environmentName: payload.environmentName,
            workspacePath: workspace.workspacePath,
            runGroupId: workspace.runGroupId,
          },
          workspace.runGroupId ? runGroupsById.get(workspace.runGroupId) : undefined,
        ),
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

    const nextCursor =
      params.limit && filteredGroups.length > limitedGroups.length
        ? (limitedGroups[limitedGroups.length - 1]?.payload?.updatedAt ?? null)
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
  const runGroupsById = await findRunGroupsByIds(
    result.items.flatMap((deployment) => (deployment.runGroupId ? [deployment.runGroupId] : [])),
    params.orgId,
  )

  return {
    data: result.items.map((deployment) =>
      serializePreview(
        deployment,
        deployment.runGroupId ? runGroupsById.get(deployment.runGroupId) : undefined,
      ),
    ),
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
previewsRoute.get("/", requireOrgAccess({ orgSource: "query", orgKey: "org" }), async (c) => {
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
  const runGroupsById = await findRunGroupsByIds(
    result.items.flatMap((deployment) => (deployment.runGroupId ? [deployment.runGroupId] : [])),
    auth.orgId,
  )

  logger.debug("list previews", {
    orgId: auth.orgId,
    repo,
    status,
    count: result.items.length,
  })

  return c.json({
    data: result.items.map((deployment) =>
      serializePreview(
        deployment,
        deployment.runGroupId ? runGroupsById.get(deployment.runGroupId) : undefined,
      ),
    ),
    nextCursor: result.nextCursor,
  })
})

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
previewsRoute.get("/stream", requireOrgAccess({ orgSource: "query", orgKey: "org" }), async (c) => {
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
        const payload = JSON.stringify(
          await buildPreviewOverviewSnapshot({
            orgId: auth.orgId,
            repo,
            status,
            prNumber: pr_number,
            limit,
            cursor,
          }),
        )

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
          sendSnapshot().catch((err) =>
            console.error(`[sse:previews] error in handleDeploymentUpdate:`, err),
          )
        }
      }
    }

    events.onDeploymentUpdate(handleDeploymentUpdate)

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      stream
        .writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
        .catch(() => {
          /* connection likely closed */
        })
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
})

// Helper to get preview orgId for resource-based auth
async function getPreviewOrgId(c: {
  req: { param: (key: string) => string | undefined }
}): Promise<string | null> {
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
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json(
        { error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } },
        404,
      )
    }

    const approvals = await listApprovals(id)

    return c.json({
      data: approvals.map((a) => ({
        id: a.id,
        deploymentId: a.deploymentId,
        runGroupId: a.runGroupId,
        userId: a.userId,
        approverLogin: a.approverLogin ?? null,
        approvedAt: a.approvedAt.toISOString(),
        executionContext: a.executionContext,
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
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const auth = getAuth(c)

    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json(
        { error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } },
        404,
      )
    }

    // Use the single triggerApply path
    try {
      const result = await triggerApply({
        previewId: id,
        actor: executionMutationActor(auth),
      })

      return c.json({
        data: {
          approved: true,
          applyStarted: result.applyStarted,
          jobId: result.jobId,
        },
      })
    } catch (err) {
      if (err instanceof ExecutionMutationDeniedError) {
        return c.json({ error: { code: err.code, message: err.message } }, 403)
      }
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
  requireResourceAccess({ minRole: "approver", getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const auth = getAuth(c)
    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json(
        { error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } },
        404,
      )
    }

    logger.info("Manual re-run requested", {
      previewId: id,
      userId: auth.userId,
      userName: auth.name,
    })

    try {
      const result = await rerunPreview({
        previewId: id,
        actor: executionMutationActor(auth),
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
      if (err instanceof ExecutionMutationDeniedError) {
        return c.json({ error: { code: err.code, message: err.message } }, 403)
      }
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
  requireResourceAccess({ minRole: "approver", getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const auth = getAuth(c)
    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json(
        { error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } },
        404,
      )
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
        actor: executionMutationActor(auth),
      })

      return c.json({
        data: {
          applyStarted: result.applyStarted,
          jobId: result.jobId,
        },
      })
    } catch (err) {
      if (err instanceof ExecutionMutationDeniedError) {
        return c.json({ error: { code: err.code, message: err.message } }, 403)
      }
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
  requireResourceAccess({ minRole: "approver", getOrgId: getPreviewOrgId }),
  async (c) => {
    const parseResult = uuidParam.safeParse(c.req.param("id"))
    if (!parseResult.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "id must be a valid UUID" } },
        400,
      )
    }
    const id = parseResult.data

    const auth = getAuth(c)
    const preview = await findDeploymentById(id)
    if (!preview) {
      return c.json(
        { error: { code: "PREVIEW_NOT_FOUND", message: `preview ${id} not found` } },
        404,
      )
    }

    logger.info("Pause requested", {
      previewId: id,
      userId: auth.userId,
      userName: auth.name,
      currentStatus: preview.status,
    })

    let result
    try {
      result = await pausePreview({
        previewId: preview.id,
        actor: executionMutationActor(auth),
      })
    } catch (error) {
      if (error instanceof ExecutionMutationDeniedError) {
        return c.json({ error: { code: error.code, message: error.message } }, 403)
      }
      if (error instanceof Error && error.message === "apply already queued or in progress") {
        return c.json({ error: { code: "APPLY_IN_PROGRESS", message: error.message } }, 409)
      }
      throw error
    }

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
        {
          error: {
            code: "ALREADY_APPLYING",
            message: "apply already in progress, too late to pause",
          },
        },
        409,
      )
    }

    if (currentStatus === "ready") {
      return c.json({ error: { code: "ALREADY_APPLIED", message: "apply already completed" } }, 409)
    }

    // Some other state we didn't expect
    return c.json(
      {
        error: {
          code: "INVALID_STATE",
          message: `cannot pause deployment in ${currentStatus} state`,
        },
      },
      400,
    )
  },
)

function executionMutationActor(auth: ReturnType<typeof getAuth>): ExecutionMutationActor {
  return {
    kind: "human",
    userId: auth.userId,
    role: auth.role,
    ...(auth.apiKeyId ? { apiKeyId: auth.apiKeyId } : {}),
  }
}

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
  headUpdatedAt: string
  executionContext: ReturnType<typeof serializeBoundExecutionSnapshotIdentity>
}

function serializePreview(
  p: {
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
    statusChangedAt: Date
    orgId: string
    runGroupId: string | null
  },
  runGroup?: RunGroupWithRepoBinding,
): SerializedPreview {
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
    headUpdatedAt: p.statusChangedAt.toISOString(),
    executionContext: serializePreviewExecutionContext(p, runGroup),
  }
}

function serializePreviewExecutionContext(
  deployment: {
    orgId: string
    repo: string
    environmentKind: string
    environmentName: string
    workspacePath: string
    runGroupId: string | null
  },
  runGroup?: RunGroupWithRepoBinding,
): ReturnType<typeof serializeBoundExecutionSnapshotIdentity> {
  if (!deployment.runGroupId || !runGroup || runGroup.id !== deployment.runGroupId) {
    return null
  }

  if (
    deployment.environmentKind === "transient" &&
    !isExecutionContextAssociationValid({
      snapshot: runGroup.executionSnapshot,
      runGroup,
      resource: deployment,
      canonicalRepoNamespace: runGroup.canonicalRepoNamespace,
      requireRepoBinding: true,
    })
  ) {
    return null
  }

  return serializeBoundExecutionSnapshotIdentity({
    snapshot: runGroup.executionSnapshot,
    runGroup,
    resource: deployment,
  })
}
