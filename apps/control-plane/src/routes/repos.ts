import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import {
  findPreviewsByPr,
  findPreviewsByEnv,
} from "../db/queries/previews.ts"
import { listRunsForPreview, findLatestRun } from "../db/queries/tf-runs.ts"
import { requireOrgAccess, getAuth } from "../middleware/org-auth.ts"
import { events, type PreviewUpdateEvent, type RunUpdateEvent } from "../lib/events.ts"
import {
  getSseSnapshotDurationHistogram,
  getSsePayloadBytesHistogram,
  getSseMessagesSentCounter,
  getSseMessagesDedupedCounter,
  getSseConnectionsActiveCounter,
} from "../lib/telemetry.ts"

const prNumberParam = z.coerce.number().int().positive()

export const reposRoute = new Hono()

// ---------------------------------------------------------------------------
// PR Routes - /api/orgs/:org/repos/:repo/pr/:prNumber
// ---------------------------------------------------------------------------

/**
 * GET /api/orgs/:org/repos/:repo/pr/:prNumber
 *
 * Get all previews (workspaces) for a PR.
 */
reposRoute.get(
  "/:org/repos/:repo/pr/:prNumber",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    const prNumberRaw = c.req.param("prNumber")

    const prParsed = prNumberParam.safeParse(prNumberRaw)
    if (!prParsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "prNumber must be a positive integer" } },
        400,
      )
    }
    const prNumber = prParsed.data

    const previews = await findPreviewsByPr(auth.orgId, repo, prNumber)

    if (previews.length === 0) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `no previews found for PR #${prNumber}` } },
        404,
      )
    }

    // Fetch runs for each preview
    const previewsWithRuns = await Promise.all(
      previews.map(async (preview) => {
        const runs = await listRunsForPreview(preview.id)
        const latestApply = await findLatestRun(preview.id, "apply")
        const outputs = latestApply?.status === "success" ? latestApply.outputs : null
        return {
          preview: serializePreview(preview),
          runs: runs.map(serializeRun),
          outputs,
        }
      }),
    )

    // Get metadata from first preview
    const first = previews[0]

    return c.json({
      data: {
        org: c.req.param("org"),
        repo,
        prNumber,
        branch: first.branch,
        headSha: first.headSha,
        authorLogin: first.authorLogin,
        workspaces: previewsWithRuns,
      },
    })
  },
)

/**
 * GET /api/orgs/:org/repos/:repo/pr/:prNumber/stream
 *
 * SSE stream for PR updates (all workspaces).
 */
reposRoute.get(
  "/:org/repos/:repo/pr/:prNumber/stream",
  requireOrgAccess({ orgSource: "param", orgKey: "org", allowQueryToken: true }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    const prNumberRaw = c.req.param("prNumber")

    const prParsed = prNumberParam.safeParse(prNumberRaw)
    if (!prParsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "prNumber must be a positive integer" } },
        400,
      )
    }
    const prNumber = prParsed.data

    return streamSSE(c, async (stream) => {
      getSseConnectionsActiveCounter().add(1, { type: "pr" })
      let lastPayload = ""
      let inFlight = false
      let pendingUpdate = false

      const sendSnapshot = async (): Promise<void> => {
        // If already fetching, mark that we need another update after
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true
        pendingUpdate = false

        try {
          const startTime = performance.now()
          const previews = await findPreviewsByPr(auth.orgId, repo, prNumber)

          if (previews.length === 0) {
            const emptyPayload = JSON.stringify({ data: null })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const previewsWithRuns = await Promise.all(
            previews.map(async (preview) => {
              const runs = await listRunsForPreview(preview.id)
              const latestApply = await findLatestRun(preview.id, "apply")
              const outputs = latestApply?.status === "success" ? latestApply.outputs : null
              return {
                preview: serializePreview(preview),
                runs: runs.map(serializeRun),
                outputs,
              }
            }),
          )

          const queryDuration = performance.now() - startTime
          getSseSnapshotDurationHistogram().record(queryDuration, {
            type: "pr",
            workspace_count: String(previewsWithRuns.length),
          })

          const first = previews[0]
          const payload = JSON.stringify({
            data: {
              org: c.req.param("org"),
              repo,
              prNumber,
              branch: first.branch,
              headSha: first.headSha,
              authorLogin: first.authorLogin,
              workspaces: previewsWithRuns,
            },
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            getSsePayloadBytesHistogram().record(payload.length, { type: "pr" })
            getSseMessagesSentCounter().add(1, { type: "snapshot" })
            console.log(`[sse:pr] sending update: workspaces=${previewsWithRuns.length} payloadLen=${payload.length}`)
            await stream.writeSSE({ event: "update", data: payload })
          } else {
            getSseMessagesDedupedCounter().add(1, { type: "pr" })
            console.log(`[sse:pr] skipping update: payload unchanged`)
          }
        } finally {
          inFlight = false
          // If updates came in while we were fetching, fetch again
          if (pendingUpdate) {
            console.log(`[sse:pr] processing pending update`)
            await sendSnapshot()
          }
        }
      }

      // Send initial snapshot
      console.log(`[sse:pr] sending initial snapshot for PR #${prNumber}`)
      await sendSnapshot()

      // Track preview IDs for this PR to filter events
      let previewIds = new Set<string>()
      const updatePreviewIds = async (): Promise<void> => {
        const previews = await findPreviewsByPr(auth.orgId, repo, prNumber)
        previewIds = new Set(previews.map((p) => p.id))
        console.log(`[sse:pr] updatePreviewIds: found ${previewIds.size} previews`)
      }
      await updatePreviewIds()

      // Listen for preview updates matching this PR
      const handlePreviewUpdate = (event: PreviewUpdateEvent): void => {
        console.log(`[sse:pr] handlePreviewUpdate: previewId=${event.previewId} matches=${event.orgId === auth.orgId && event.repo === repo && event.prNumber === prNumber}`)
        if (event.orgId === auth.orgId && event.repo === repo && event.prNumber === prNumber) {
          updatePreviewIds()
            .then(() => sendSnapshot())
            .catch((err) => console.error(`[sse:pr] error in handlePreviewUpdate:`, err))
        }
      }

      // Listen for run updates for any preview in this PR
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        console.log(`[sse:pr] handleRunUpdate: previewId=${event.previewId} inSet=${previewIds.has(event.previewId)} setSize=${previewIds.size}`)
        if (previewIds.has(event.previewId)) {
          sendSnapshot().catch((err) => console.error(`[sse:pr] error in handleRunUpdate:`, err))
        }
      }

      events.onPreviewUpdate(handlePreviewUpdate)
      events.onRunUpdate(handleRunUpdate)
      console.log(`[sse:pr] connected: PR #${prNumber}`)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => { /* connection likely closed */ })
      }, 30_000)

      stream.onAbort(() => {
        console.log(`[sse:pr] onAbort called: PR #${prNumber}`)
        getSseConnectionsActiveCounter().add(-1, { type: "pr" })
        clearInterval(heartbeat)
        events.offPreviewUpdate(handlePreviewUpdate)
        events.offRunUpdate(handleRunUpdate)
      })
    })
  },
)

// ---------------------------------------------------------------------------
// Environment Routes - /api/orgs/:org/repos/:repo/env/:branch
// ---------------------------------------------------------------------------

/**
 * GET /api/orgs/:org/repos/:repo/env/:branch
 *
 * Get all previews (workspaces) for a long-lived environment.
 */
reposRoute.get(
  "/:org/repos/:repo/env/:branch",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    const branch = c.req.param("branch")

    const previews = await findPreviewsByEnv(auth.orgId, repo, branch)

    if (previews.length === 0) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `no previews found for branch ${branch}` } },
        404,
      )
    }

    // Fetch runs for each preview
    const previewsWithRuns = await Promise.all(
      previews.map(async (preview) => {
        const runs = await listRunsForPreview(preview.id)
        const latestApply = await findLatestRun(preview.id, "apply")
        const outputs = latestApply?.status === "success" ? latestApply.outputs : null
        return {
          preview: serializePreview(preview),
          runs: runs.map(serializeRun),
          outputs,
        }
      }),
    )

    const first = previews[0]

    return c.json({
      data: {
        org: c.req.param("org"),
        repo,
        branch,
        headSha: first.headSha,
        workspaces: previewsWithRuns,
      },
    })
  },
)

/**
 * GET /api/orgs/:org/repos/:repo/env/:branch/stream
 *
 * SSE stream for environment updates (all workspaces).
 */
reposRoute.get(
  "/:org/repos/:repo/env/:branch/stream",
  requireOrgAccess({ orgSource: "param", orgKey: "org", allowQueryToken: true }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    const branch = c.req.param("branch")

    return streamSSE(c, async (stream) => {
      getSseConnectionsActiveCounter().add(1, { type: "env" })
      let lastPayload = ""
      let inFlight = false
      let pendingUpdate = false

      const sendSnapshot = async (): Promise<void> => {
        // If already fetching, mark that we need another update after
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true
        pendingUpdate = false

        try {
          const startTime = performance.now()
          const previews = await findPreviewsByEnv(auth.orgId, repo, branch)

          if (previews.length === 0) {
            const emptyPayload = JSON.stringify({ data: null })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const previewsWithRuns = await Promise.all(
            previews.map(async (preview) => {
              const runs = await listRunsForPreview(preview.id)
              const latestApply = await findLatestRun(preview.id, "apply")
              const outputs = latestApply?.status === "success" ? latestApply.outputs : null
              return {
                preview: serializePreview(preview),
                runs: runs.map(serializeRun),
                outputs,
              }
            }),
          )

          const queryDuration = performance.now() - startTime
          getSseSnapshotDurationHistogram().record(queryDuration, {
            type: "env",
            workspace_count: String(previewsWithRuns.length),
          })

          const first = previews[0]
          const payload = JSON.stringify({
            data: {
              org: c.req.param("org"),
              repo,
              branch,
              headSha: first.headSha,
              workspaces: previewsWithRuns,
            },
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            getSsePayloadBytesHistogram().record(payload.length, { type: "env" })
            getSseMessagesSentCounter().add(1, { type: "snapshot" })
            await stream.writeSSE({ event: "update", data: payload })
          } else {
            getSseMessagesDedupedCounter().add(1, { type: "env" })
          }
        } finally {
          inFlight = false
          // If updates came in while we were fetching, fetch again
          if (pendingUpdate) {
            await sendSnapshot()
          }
        }
      }

      // Send initial snapshot
      await sendSnapshot()

      // Track preview IDs for this env to filter events
      let previewIds = new Set<string>()
      const updatePreviewIds = async (): Promise<void> => {
        const previews = await findPreviewsByEnv(auth.orgId, repo, branch)
        previewIds = new Set(previews.map((p) => p.id))
      }
      await updatePreviewIds()

      // Listen for preview updates matching this env (prNumber=0 for envs)
      const handlePreviewUpdate = (event: PreviewUpdateEvent): void => {
        if (event.orgId === auth.orgId && event.repo === repo && event.prNumber === 0) {
          updatePreviewIds()
            .then(() => sendSnapshot())
            .catch((err) => console.error(`[sse:env] error in handlePreviewUpdate:`, err))
        }
      }

      // Listen for run updates for any preview in this env
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        if (previewIds.has(event.previewId)) {
          sendSnapshot().catch((err) => console.error(`[sse:env] error in handleRunUpdate:`, err))
        }
      }

      events.onPreviewUpdate(handlePreviewUpdate)
      events.onRunUpdate(handleRunUpdate)
      console.log(`[sse:env] connected: ${branch}`)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => { /* connection likely closed */ })
      }, 30_000)

      stream.onAbort(() => {
        console.log(`[sse:env] onAbort called: ${branch}`)
        getSseConnectionsActiveCounter().add(-1, { type: "env" })
        clearInterval(heartbeat)
        events.offPreviewUpdate(handlePreviewUpdate)
        events.offRunUpdate(handleRunUpdate)
      })
    })
  },
)

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

interface SerializedPreview {
  id: string
  workspacePath: string
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  createdAt: string
}

function serializePreview(p: {
  id: string
  workspacePath: string
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  createdAt: Date
}): SerializedPreview {
  return {
    id: p.id,
    workspacePath: p.workspacePath,
    status: p.status,
    stateKey: p.stateKey,
    mode: p.mode,
    requireApproval: p.requireApproval,
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
  logOutput: string | null
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
  logOutput: string | null
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
    logOutput: r.logOutput,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}
