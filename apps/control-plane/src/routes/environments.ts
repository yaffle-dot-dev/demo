import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { listDeployments } from "../db/queries/workspace-deployments.ts"
import { findLatestRunsForDeployments } from "../db/queries/tf-runs.ts"
import { listConnectionsForOrg } from "../db/queries/connections.ts"
import { listEnvironmentGroupProjections } from "../db/queries/environment-group-projections.ts"
import { findRunGroupWorkspaceMetadataForRunGroups } from "../db/queries/run-group-workspace-metadata.ts"
import { findRunGroupsByIds, type RunGroupWithRepoBinding } from "../db/queries/run-groups.ts"
import { requireOrgAccess, getAuth } from "../middleware/org-auth.ts"
import {
  formatConnectionBlockedReason,
  getConnectionReadinessForDeploymentWithDeps,
  type ConnectionReadiness,
  type WorkspaceDegradation,
} from "../lib/execution-credentials.ts"
import {
  getRequiredProviderRequirementsForDeployment,
  getRequiredProvidersForDeployment,
} from "../lib/provider-requirements.ts"
import { parseEnvironmentGroupProjectionPayload } from "../lib/projections/environment-groups.ts"
import { logger, withSpan } from "../lib/telemetry.ts"
import {
  isExecutionContextAssociationValid,
  serializeBoundExecutionSnapshotIdentity,
} from "../lib/execution-snapshot.ts"

const listQuerySchema = z.object({
  org: z.string().min(1),
  repo: z.string().optional(),
  token: z.string().optional(), // For SSE auth
  view: z.enum(["full", "dag"]).optional(),
})

export const environmentsRoute = new Hono()

const ENVIRONMENTS_CACHE_TTL_MS = 3_000
const ENVIRONMENTS_SLOW_REQUEST_MS = 5_000
const ENVIRONMENTS_LARGE_HEAP_DELTA_BYTES = 64 * 1024 * 1024

interface MemorySnapshot {
  heapUsed: number
  rss: number
}

interface EnvironmentsLoadStats {
  deploymentCount: number
  runGroupCount: number
  environmentCount: number
  workspaceCount: number
}

interface EnvironmentsLoadResult {
  environments: EnvironmentGroup[]
  stats: EnvironmentsLoadStats
  phaseMetrics: Record<string, number>
}

interface EnvironmentsCacheEntry {
  expiresAt: number
  value?: EnvironmentsLoadResult
  inFlight?: Promise<EnvironmentsLoadResult>
}

const environmentsCache = new Map<string, EnvironmentsCacheEntry>()

function getMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage()
  return {
    heapUsed: usage.heapUsed,
    rss: usage.rss,
  }
}

function summarizeEnvironmentCounts(
  environments: EnvironmentGroup[],
): Pick<EnvironmentsLoadStats, "environmentCount" | "workspaceCount"> {
  return {
    environmentCount: environments.length,
    workspaceCount: environments.reduce(
      (total, environment) => total + environment.workspaces.length,
      0,
    ),
  }
}

async function loadEnvironmentGroupsFromProjections(
  orgId: string,
  repo?: string,
): Promise<EnvironmentGroup[]> {
  const rows = await listEnvironmentGroupProjections({
    orgId,
    repo,
    environmentKind: "named",
  })

  if (rows.some((row) => row.version < 2)) {
    return []
  }

  const payloads = rows.flatMap((row) => {
    const payload = parseEnvironmentGroupProjectionPayload(row.payload)
    return payload?.environmentKind === "named" ? [payload] : []
  })
  const runGroupsById = await findRunGroupsByIds(
    payloads.flatMap((payload) =>
      payload.workspaces.flatMap((workspace) =>
        workspace.runGroupId ? [workspace.runGroupId] : [],
      ),
    ),
    orgId,
  )

  const environments: EnvironmentGroup[] = []
  for (const payload of payloads) {
    environments.push({
      repo: payload.repo,
      ref: payload.ref,
      environmentName: payload.environmentName,
      headSha: payload.headSha,
      status: payload.status,
      updatedAt: payload.updatedAt,
      dependencyGraph: payload.dependencyGraph,
      workspaces: payload.workspaces.map((workspace) => ({
        previewId: workspace.deploymentId,
        workspacePath: workspace.workspacePath,
        status: workspace.status,
        connectionStatus: workspace.connectionStatus,
        missingProviders: workspace.missingProviders,
        conflictProviders: workspace.conflictProviders,
        matchedConnections: workspace.matchedConnections,
        blockedReason: workspace.blockedReason,
        degradation: workspace.degradation ?? null,
        headSha: workspace.headSha,
        lastRunId: workspace.lastRunId,
        lastRunType: workspace.lastRunType,
        lastRunStatus: workspace.lastRunStatus,
        lastRunCompletedAt: workspace.lastRunCompletedAt,
        planSummary: workspace.planSummary,
        executionContext: serializeEnvironmentExecutionContext(
          orgId,
          payload,
          workspace,
          workspace.runGroupId ? runGroupsById.get(workspace.runGroupId) : undefined,
        ),
      })),
    })
  }

  return environments
}

function setPhaseMetric(
  metrics: Record<string, number>,
  phase: string,
  startedAtMs: number,
  endedAtMs = Date.now(),
  memoryBefore?: MemorySnapshot,
  memoryAfter?: MemorySnapshot,
): void {
  metrics[`${phase}.durationMs`] = endedAtMs - startedAtMs

  if (memoryBefore && memoryAfter) {
    metrics[`${phase}.heapDeltaBytes`] = memoryAfter.heapUsed - memoryBefore.heapUsed
    metrics[`${phase}.rssDeltaBytes`] = memoryAfter.rss - memoryBefore.rss
  }
}

async function profileSubphase<T>(
  metrics: Record<string, number>,
  phase: string,
  fn: () => Promise<T>,
  count: (result: T) => number,
): Promise<T> {
  const startedAt = Date.now()
  const memoryBefore = getMemorySnapshot()
  const result = await fn()
  const endedAt = Date.now()
  const memoryAfter = getMemorySnapshot()

  setPhaseMetric(metrics, phase, startedAt, endedAt, memoryBefore, memoryAfter)
  metrics[`${phase}.itemCount`] = count(result)

  return result
}

interface EnvironmentWorkspace {
  previewId: string
  workspacePath: string
  status: string
  connectionStatus: "ready" | "missing" | "conflict" | "not_required"
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{ id: string; name: string; provider: string }>
  blockedReason: string | null
  degradation: WorkspaceDegradation | null
  headSha: string
  lastRunId: string | null
  lastRunType: string | null
  lastRunStatus: string | null
  lastRunCompletedAt: string | null
  planSummary: string | null
  executionContext: ReturnType<typeof serializeBoundExecutionSnapshotIdentity>
}

interface EnvironmentGroup {
  repo: string
  ref: string
  environmentName: string
  headSha: string
  status: string
  updatedAt: string
  dependencyGraph: {
    workspaces: string[]
    edges: [string, string][]
  } | null
  workspaces: EnvironmentWorkspace[]
}

/**
 * GET /api/environments?org=owner&repo=owner/repo
 *
 * Returns latest production status grouped by branch.
 */
environmentsRoute.get("/", requireOrgAccess({ orgSource: "query", orgKey: "org" }), async (c) => {
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
})

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
  return withSpan("environments.fetch", async (span) => {
    const cacheKey = `${orgId}:${repo ?? "*"}:${detailLevel}`
    const startedAt = Date.now()
    const memoryBefore = getMemorySnapshot()
    let cacheResult: "hit" | "coalesced" | "miss" = "miss"

    const setSpanAttributes = (result: EnvironmentsLoadResult | null): void => {
      const memoryAfter = getMemorySnapshot()
      const durationMs = Date.now() - startedAt
      const heapUsedDeltaBytes = memoryAfter.heapUsed - memoryBefore.heapUsed
      const rssDeltaBytes = memoryAfter.rss - memoryBefore.rss

      const spanAttrs: Record<string, string | number> = {
        "yaffle.org_id": orgId,
        "yaffle.repo": repo ?? "",
        "environments.detail_level": detailLevel,
        "environments.cache_result": cacheResult,
        "environments.duration_ms": durationMs,
        "process.heap_used_before_bytes": memoryBefore.heapUsed,
        "process.heap_used_after_bytes": memoryAfter.heapUsed,
        "process.heap_used_delta_bytes": heapUsedDeltaBytes,
        "process.rss_before_bytes": memoryBefore.rss,
        "process.rss_after_bytes": memoryAfter.rss,
        "process.rss_delta_bytes": rssDeltaBytes,
      }

      const logAttrs: Record<string, string | number> = {
        orgId,
        repo: repo ?? "",
        detailLevel,
        cacheResult,
        durationMs,
        heapUsedBeforeBytes: memoryBefore.heapUsed,
        heapUsedAfterBytes: memoryAfter.heapUsed,
        heapUsedDeltaBytes,
        rssBeforeBytes: memoryBefore.rss,
        rssAfterBytes: memoryAfter.rss,
        rssDeltaBytes,
      }

      if (result) {
        spanAttrs["environments.deployments_scanned"] = result.stats.deploymentCount
        spanAttrs["environments.run_groups_scanned"] = result.stats.runGroupCount
        spanAttrs["environments.environments_returned"] = result.stats.environmentCount
        spanAttrs["environments.workspaces_returned"] = result.stats.workspaceCount
        for (const [key, value] of Object.entries(result.phaseMetrics)) {
          spanAttrs[`environments.phase.${key}`] = value
        }

        logAttrs.deploymentCount = result.stats.deploymentCount
        logAttrs.runGroupCount = result.stats.runGroupCount
        logAttrs.environmentCount = result.stats.environmentCount
        logAttrs.workspaceCount = result.stats.workspaceCount
        for (const [key, value] of Object.entries(result.phaseMetrics)) {
          logAttrs[key] = value
        }
      }

      span.setAttributes(spanAttrs)

      if (
        durationMs >= ENVIRONMENTS_SLOW_REQUEST_MS ||
        heapUsedDeltaBytes >= ENVIRONMENTS_LARGE_HEAP_DELTA_BYTES
      ) {
        logger.warn("environments.fetch.profile", logAttrs)
      }
    }

    const now = Date.now()
    const cached = environmentsCache.get(cacheKey)

    if (cached?.value && cached.expiresAt > now) {
      cacheResult = "hit"
      setSpanAttributes(cached.value)
      return cached.value.environments
    }

    if (cached?.inFlight) {
      cacheResult = "coalesced"
      const result = await cached.inFlight
      setSpanAttributes(result)
      return result.environments
    }

    const loadPromise = loadEnvironments(orgId, repo, detailLevel)
    environmentsCache.set(cacheKey, {
      expiresAt: now + ENVIRONMENTS_CACHE_TTL_MS,
      inFlight: loadPromise,
    })

    try {
      const result = await loadPromise
      environmentsCache.set(cacheKey, {
        expiresAt: Date.now() + ENVIRONMENTS_CACHE_TTL_MS,
        value: result,
      })
      setSpanAttributes(result)
      return result.environments
    } catch (error) {
      environmentsCache.delete(cacheKey)
      setSpanAttributes(null)
      logger.error("environments.fetch.failed", {
        error: error instanceof Error ? error.message : String(error),
        orgId,
        repo: repo ?? undefined,
        detailLevel,
        cacheResult,
      })
      throw error
    }
  })
}

async function loadEnvironments(
  orgId: string,
  repo?: string,
  detailLevel: "full" | "dag" = "full",
): Promise<EnvironmentsLoadResult> {
  const phaseMetrics: Record<string, number> = {}

  const projectionStartedAt = Date.now()
  const projectionMemoryBefore = getMemorySnapshot()
  const projectedEnvironments = await loadEnvironmentGroupsFromProjections(orgId, repo)
  setPhaseMetric(
    phaseMetrics,
    "loadProjectionRows",
    projectionStartedAt,
    Date.now(),
    projectionMemoryBefore,
    getMemorySnapshot(),
  )
  phaseMetrics["loadProjectionRows.itemCount"] = projectedEnvironments.length

  if (projectedEnvironments.length > 0) {
    return {
      environments: projectedEnvironments,
      stats: {
        deploymentCount: projectedEnvironments.reduce(
          (total, environment) => total + environment.workspaces.length,
          0,
        ),
        runGroupCount: 0,
        ...summarizeEnvironmentCounts(projectedEnvironments),
      },
      phaseMetrics,
    }
  }

  const listDeploymentsStartedAt = Date.now()
  const listDeploymentsMemoryBefore = getMemorySnapshot()
  const result = await listDeployments(orgId, {
    repo,
    environmentKind: "named",
    limit: 250,
  })
  setPhaseMetric(
    phaseMetrics,
    "listDeployments",
    listDeploymentsStartedAt,
    Date.now(),
    listDeploymentsMemoryBefore,
    getMemorySnapshot(),
  )

  // Filter out destroyed workspaces - they're no longer in the config
  const activePreviews = result.items.filter((p) => p.status !== "destroyed")
  if (activePreviews.length === 0) {
    return {
      environments: [],
      stats: {
        deploymentCount: 0,
        runGroupCount: 0,
        environmentCount: 0,
        workspaceCount: 0,
      },
      phaseMetrics,
    }
  }

  const metadataStart = Date.now()
  const metadataMemoryBefore = getMemorySnapshot()

  const deploymentIds = activePreviews.map((p) => p.id)
  const deploymentRunGroupIds = [
    ...new Set(
      activePreviews
        .map((preview) => preview.runGroupId)
        .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
    ),
  ]
  const runGroupsById = await findRunGroupsByIds(deploymentRunGroupIds, orgId)

  if (detailLevel === "dag") {
    const groups = new Map<string, EnvironmentGroup>()
    const dagGroupingStartedAt = Date.now()
    const dagGroupingMemoryBefore = getMemorySnapshot()

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
        degradation: null,
        headSha: preview.headSha,
        lastRunId: null,
        lastRunType: null,
        lastRunStatus: null,
        lastRunCompletedAt: null,
        planSummary: null,
        executionContext: serializeEnvironmentExecutionContext(
          orgId,
          preview,
          preview,
          preview.runGroupId ? runGroupsById.get(preview.runGroupId) : undefined,
        ),
      }

      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          repo: preview.repo,
          ref: preview.ref,
          environmentName: preview.environmentName,
          headSha: preview.headSha,
          status: preview.status,
          updatedAt: preview.statusChangedAt.toISOString(),
          dependencyGraph: null,
          workspaces: [workspace],
        })
        continue
      }

      existing.workspaces.push(workspace)
      existing.status = aggregateStatus(existing.workspaces)
      const candidateTime = preview.statusChangedAt.toISOString()
      if (new Date(candidateTime) > new Date(existing.updatedAt)) {
        existing.updatedAt = candidateTime
        existing.headSha = preview.headSha
        existing.ref = preview.ref
      }
    }

    setPhaseMetric(
      phaseMetrics,
      "groupEnvironmentsDag",
      dagGroupingStartedAt,
      Date.now(),
      dagGroupingMemoryBefore,
      getMemorySnapshot(),
    )

    const environments = Array.from(groups.values())
    return {
      environments,
      stats: {
        deploymentCount: activePreviews.length,
        runGroupCount: deploymentRunGroupIds.length,
        ...summarizeEnvironmentCounts(environments),
      },
      phaseMetrics,
    }
  }

  // Batch fetch all supporting data in parallel, but profile each source separately.
  const [applyRunsMap, allRunsMap, orgConnections, metadataByRunGroupWorkspaceKey] =
    await Promise.all([
      profileSubphase(
        phaseMetrics,
        "loadSupportingData.applyRuns",
        () => findLatestRunsForDeployments(deploymentIds, "apply"),
        (result) => result.size,
      ),
      profileSubphase(
        phaseMetrics,
        "loadSupportingData.allRuns",
        () => findLatestRunsForDeployments(deploymentIds),
        (result) => result.size,
      ),
      profileSubphase(
        phaseMetrics,
        "loadSupportingData.orgConnections",
        () => listConnectionsForOrg(orgId),
        (result) => result.length,
      ),
      profileSubphase(
        phaseMetrics,
        "loadSupportingData.workspaceMetadata",
        () => findRunGroupWorkspaceMetadataForRunGroups(deploymentRunGroupIds),
        (result) => result.size,
      ),
    ])

  setPhaseMetric(
    phaseMetrics,
    "loadSupportingData",
    metadataStart,
    Date.now(),
    metadataMemoryBefore,
    getMemorySnapshot(),
  )

  // Build connection readiness for each deployment using the pre-fetched connections
  const readinessMap = new Map<string, ConnectionReadiness>()
  const readinessStart = Date.now()
  const readinessMemoryBefore = getMemorySnapshot()
  await Promise.all(
    activePreviews.map(async (preview) => {
      const readiness = await getConnectionReadinessForDeploymentWithDeps(preview, {
        getProvidersForDeployment: getRequiredProvidersForDeployment,
        getProviderRequirementsForDeployment: (deployment) =>
          getRequiredProviderRequirementsForDeployment(deployment, {
            metadata: deployment.runGroupId
              ? (metadataByRunGroupWorkspaceKey.get(
                  `${deployment.runGroupId}:${deployment.workspacePath}`,
                ) ?? null)
              : null,
          }),
        listConnectionsForOrg: async () => orgConnections,
        resolveConnectionEnv: async () => ({}), // Not needed for readiness check
      })
      readinessMap.set(preview.id, readiness)
    }),
  )
  setPhaseMetric(
    phaseMetrics,
    "buildReadiness",
    readinessStart,
    Date.now(),
    readinessMemoryBefore,
    getMemorySnapshot(),
  )

  const groups = new Map<string, EnvironmentGroup>()
  const groupStart = Date.now()
  const groupMemoryBefore = getMemorySnapshot()

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
      degradation: connectionReadiness.degradation ?? null,
      headSha: preview.headSha,
      lastRunId: latestRun?.id ?? null,
      lastRunType: latestRun?.runType ?? null,
      lastRunStatus: latestRun?.status ?? null,
      lastRunCompletedAt: latestRun?.completedAt?.toISOString() ?? null,
      planSummary: latestRun?.planSummary ?? null,
      executionContext: serializeEnvironmentExecutionContext(
        orgId,
        preview,
        preview,
        preview.runGroupId ? runGroupsById.get(preview.runGroupId) : undefined,
      ),
    }

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        repo: preview.repo,
        ref: preview.ref,
        environmentName: preview.environmentName,
        headSha: preview.headSha,
        status: preview.status,
        updatedAt: preview.statusChangedAt.toISOString(),
        dependencyGraph: null,
        workspaces: [workspace],
      })
      continue
    }

    existing.workspaces.push(workspace)

    existing.status = aggregateStatus(existing.workspaces)

    const candidateTime = preview.statusChangedAt.toISOString()
    if (new Date(candidateTime) > new Date(existing.updatedAt)) {
      existing.updatedAt = candidateTime
      existing.headSha = preview.headSha
      existing.ref = preview.ref
    }
  }
  setPhaseMetric(
    phaseMetrics,
    "groupEnvironments",
    groupStart,
    Date.now(),
    groupMemoryBefore,
    getMemorySnapshot(),
  )

  const environments = Array.from(groups.values())
  return {
    environments,
    stats: {
      deploymentCount: activePreviews.length,
      runGroupCount: deploymentRunGroupIds.length,
      ...summarizeEnvironmentCounts(environments),
    },
    phaseMetrics,
  }
}

function serializeEnvironmentExecutionContext(
  orgId: string,
  environment: {
    repo: string
    environmentKind?: string
    environmentName: string
  },
  workspace: {
    workspacePath: string
    runGroupId: string | null
  },
  runGroup?: RunGroupWithRepoBinding,
): ReturnType<typeof serializeBoundExecutionSnapshotIdentity> {
  if (!workspace.runGroupId || !runGroup || runGroup.id !== workspace.runGroupId) {
    return null
  }

  const resource = {
    orgId,
    repo: environment.repo,
    environmentKind: environment.environmentKind ?? "named",
    environmentName: environment.environmentName,
    workspacePath: workspace.workspacePath,
  }
  if (
    resource.environmentKind === "transient" &&
    !isExecutionContextAssociationValid({
      snapshot: runGroup.executionSnapshot,
      runGroup,
      resource,
      canonicalRepoNamespace: runGroup.canonicalRepoNamespace,
      requireRepoBinding: true,
    })
  ) {
    return null
  }

  return serializeBoundExecutionSnapshotIdentity({
    snapshot: runGroup.executionSnapshot,
    runGroup,
    resource,
  })
}

function aggregateStatus(workspaces: EnvironmentWorkspace[]): string {
  const statuses = new Set(workspaces.map((ws) => ws.status))
  if (statuses.has("failed")) return "failed"
  if (
    statuses.has("applying") ||
    statuses.has("activating") ||
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
