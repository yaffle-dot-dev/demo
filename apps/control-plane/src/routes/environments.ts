import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { listPreviews } from "../db/queries/previews.ts"
import { findLatestRun } from "../db/queries/tf-runs.ts"
import { requireOrgAccess, getAuth } from "../middleware/org-auth.ts"

const listQuerySchema = z.object({
  org: z.string().min(1),
  repo: z.string().optional(),
  token: z.string().optional(), // For SSE auth
})

export const environmentsRoute = new Hono()

interface EnvironmentWorkspace {
  previewId: string
  workspacePath: string
  status: string
  headSha: string
  lastRunId: string | null
  lastRunType: string | null
  lastRunStatus: string | null
  lastRunCompletedAt: string | null
  planSummary: string | null
}

interface EnvironmentGroup {
  repo: string
  branch: string
  headSha: string
  status: string
  updatedAt: string
  workspaces: EnvironmentWorkspace[]
}

/**
 * GET /api/environments?org=owner&repo=owner/repo
 *
 * Returns latest production status grouped by branch.
 */
environmentsRoute.get(
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

    const { repo } = parsed.data
    const auth = getAuth(c)

    const environments = await fetchEnvironments(auth.orgId, repo)
    return c.json({ data: environments })
  },
)

/**
 * GET /api/environments/stream?org=owner&repo=owner/repo
 *
 * SSE stream for real-time environment status updates.
 */
environmentsRoute.get(
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

    const { repo } = parsed.data
    const auth = getAuth(c)

    return streamSSE(c, async (stream) => {
      let lastPayload = ""
      let inFlight = false

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) return
        inFlight = true
        try {
          const environments = await fetchEnvironments(auth.orgId, repo)
          const payload = JSON.stringify({ data: environments })

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

      // Block the callback so Hono doesn't call stream.close() in its
      // finally block.  Resolves only when the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(interval)
          resolve()
        })
      })
    })
  },
)

/**
 * Fetch environment data for an org, optionally filtered by repo.
 */
async function fetchEnvironments(
  orgId: string,
  repo?: string,
): Promise<EnvironmentGroup[]> {
  const result = await listPreviews(orgId, {
    repo,
    prNumber: 0,
    limit: 250,
  })

  const groups = new Map<string, EnvironmentGroup>()

  // Filter out destroyed workspaces - they're no longer in the config
  const activePreviews = result.items.filter((p) => p.status !== "destroyed")

  for (const preview of activePreviews) {
    const key = `${preview.repo}:${preview.branch}`

    const latestApply = await findLatestRun(preview.id, "apply")
    const latestRun = latestApply ?? (await findLatestRun(preview.id))

    const workspace: EnvironmentWorkspace = {
      previewId: preview.id,
      workspacePath: preview.workspacePath,
      status: preview.status,
      headSha: preview.headSha,
      lastRunId: latestRun?.id ?? null,
      lastRunType: latestRun?.runType ?? null,
      lastRunStatus: latestRun?.status ?? null,
      lastRunCompletedAt: latestRun?.completedAt?.toISOString() ?? null,
      planSummary: latestRun?.planSummary ?? null,
    }

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        repo: preview.repo,
        branch: preview.branch,
        headSha: preview.headSha,
        status: preview.status,
        updatedAt: latestRun?.completedAt?.toISOString() ?? preview.createdAt.toISOString(),
        workspaces: [workspace],
      })
      continue
    }

    existing.workspaces.push(workspace)
    if (preview.headSha !== existing.headSha) {
      existing.headSha = preview.headSha
    }

    existing.status = aggregateStatus(existing.workspaces)

    const candidateTime = latestRun?.completedAt?.toISOString() ?? preview.createdAt.toISOString()
    if (new Date(candidateTime) > new Date(existing.updatedAt)) {
      existing.updatedAt = candidateTime
    }
  }

  return Array.from(groups.values())
}

function aggregateStatus(workspaces: EnvironmentWorkspace[]): string {
  const statuses = new Set(workspaces.map((ws) => ws.status))
  if (statuses.has("failed")) return "failed"
  if (
    statuses.has("applying") ||
    statuses.has("planning") ||
    statuses.has("pending") ||
    statuses.has("awaiting_approval")
  ) {
    return "applying"
  }
  if (statuses.has("destroying")) return "destroying"
  if (statuses.has("ready")) return "ready"
  if (statuses.has("destroyed")) return "destroyed"
  return "pending"
}
