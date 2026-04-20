import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { listDeployments } from "../db/queries/workspace-deployments.ts"
import { findLatestRunsForDeployments } from "../db/queries/tf-runs.ts"
import { listConnectionsForOrg } from "../db/queries/connections.ts"
import { requireOrgAccess, getAuth } from "../middleware/org-auth.ts"
import {
  formatConnectionBlockedReason,
  getConnectionReadinessForDeploymentWithDeps,
  type ConnectionReadiness,
} from "../lib/execution-credentials.ts"
import { getRequiredProvidersForDeployment } from "../lib/provider-requirements.ts"

const listQuerySchema = z.object({
  org: z.string().min(1),
  repo: z.string().optional(),
  token: z.string().optional(), // For SSE auth
  view: z.enum(["full", "dag"]).optional(),
})

export const environmentsRoute = new Hono()

interface EnvironmentWorkspace {
  previewId: string
  workspacePath: string
  status: string
  connectionStatus: "ready" | "missing" | "conflict" | "not_required"
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{ id: string; name: string; provider: string }>
  blockedReason: string | null
  headSha: string
  lastRunId: string | null
  lastRunType: string | null
  lastRunStatus: string | null
  lastRunCompletedAt: string | null
  planSummary: string | null
}

interface EnvironmentGroup {
  repo: string
  ref: string
  environmentName: string
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

    const { repo, view } = parsed.data
    const auth = getAuth(c)

    const environments = await fetchEnvironments(auth.orgId, repo, view ?? "full")
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

    const { repo, view } = parsed.data
    const auth = getAuth(c)

    return streamSSE(c, async (stream) => {
      let lastPayload = ""
      let inFlight = false

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) return
        inFlight = true
        try {
          const environments = await fetchEnvironments(auth.orgId, repo, view ?? "full")
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
 *
 * Batches all DB lookups to avoid N+1 queries:
 * 1. List deployments (1 query)
 * 2. Latest apply runs for all deployments (1 query)
 * 3. Latest runs (any type) for all deployments (1 query)
 * 4. Latest jobs for all deployments (1 query)
 * 5. Connections for the org (1 query)
 * 6. Provider requirements per deployment (cached/parallel)
 */
async function fetchEnvironments(
  orgId: string,
  repo?: string,
  detailLevel: "full" | "dag" = "full",
): Promise<EnvironmentGroup[]> {
  const result = await listDeployments(orgId, {
    repo,
    environmentKind: "named",
    limit: 250,
  })

  // Filter out destroyed workspaces - they're no longer in the config
  const activePreviews = result.items.filter((p) => p.status !== "destroyed")
  if (activePreviews.length === 0) return []

  const deploymentIds = activePreviews.map((p) => p.id)

  if (detailLevel === "dag") {
    const groups = new Map<string, EnvironmentGroup>()

    for (const preview of activePreviews) {
      const key = `${preview.repo}:${preview.environmentName}`
      const workspace: EnvironmentWorkspace = {
        previewId: preview.id,
        workspacePath: preview.workspacePath,
        status: preview.status,
        connectionStatus: "not_required",
        missingProviders: [],
        conflictProviders: [],
        matchedConnections: [],
        blockedReason: null,
        headSha: preview.headSha,
        lastRunId: null,
        lastRunType: null,
        lastRunStatus: null,
        lastRunCompletedAt: null,
        planSummary: null,
      }

      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          repo: preview.repo,
          ref: preview.ref,
          environmentName: preview.environmentName,
          headSha: preview.headSha,
          status: preview.status,
          updatedAt: preview.createdAt.toISOString(),
          workspaces: [workspace],
        })
        continue
      }

      existing.workspaces.push(workspace)
      if (preview.headSha !== existing.headSha) {
        existing.headSha = preview.headSha
      }
      existing.status = aggregateStatus(existing.workspaces)
      const candidateTime = preview.createdAt.toISOString()
      if (new Date(candidateTime) > new Date(existing.updatedAt)) {
        existing.updatedAt = candidateTime
      }
    }

    return Array.from(groups.values())
  }

  // Batch fetch all data in parallel (5 queries instead of N*4)
  const [applyRunsMap, allRunsMap, orgConnections] = await Promise.all([
    findLatestRunsForDeployments(deploymentIds, "apply"),
    findLatestRunsForDeployments(deploymentIds),
    listConnectionsForOrg(orgId),
  ])

  // Build connection readiness for each deployment using the pre-fetched connections
  const readinessMap = new Map<string, ConnectionReadiness>()
  await Promise.all(
    activePreviews.map(async (preview) => {
      const readiness = await getConnectionReadinessForDeploymentWithDeps(preview, {
        getProvidersForDeployment: getRequiredProvidersForDeployment,
        listConnectionsForOrg: async () => orgConnections,
        resolveConnectionEnv: async () => ({}), // Not needed for readiness check
      })
      readinessMap.set(preview.id, readiness)
    }),
  )

  const groups = new Map<string, EnvironmentGroup>()

  for (const preview of activePreviews) {
    const key = `${preview.repo}:${preview.environmentName}`

    const latestApply = applyRunsMap.get(preview.id)
    const latestRun = latestApply ?? allRunsMap.get(preview.id)
    const connectionReadiness = readinessMap.get(preview.id)!

    const workspace: EnvironmentWorkspace = {
      previewId: preview.id,
      workspacePath: preview.workspacePath,
      status: preview.status,
      connectionStatus: connectionReadiness.status,
      missingProviders: connectionReadiness.missingProviders,
      conflictProviders: connectionReadiness.conflictProviders,
      matchedConnections: connectionReadiness.matchedConnections,
      blockedReason: formatConnectionBlockedReason(connectionReadiness),
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
        ref: preview.ref,
        environmentName: preview.environmentName,
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
