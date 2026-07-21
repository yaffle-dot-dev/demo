import {
  buildRunGroupWorkspaceMetadataKey,
  findRunGroupWorkspaceMetadataForRunGroups,
} from "../../db/queries/run-group-workspace-metadata.ts"
import { findLatestRunsForDeployments } from "../../db/queries/tf-runs.ts"
import { getLatestDependencyGraphsForOrg } from "../../db/queries/run-groups.ts"
import { listConnectionsForOrg } from "../../db/queries/connections.ts"
import {
  listLatestDeploymentsForOrg,
  type WorkspaceDeployment,
} from "../../db/queries/workspace-deployments.ts"
import {
  deleteEnvironmentGroupProjectionsByIds,
  listEnvironmentGroupProjections,
  upsertEnvironmentGroupProjections,
  type NewEnvironmentGroupProjection,
} from "../../db/queries/environment-group-projections.ts"
import {
  formatConnectionBlockedReason,
  getConnectionReadinessForDeploymentWithDeps,
  type WorkspaceDegradation,
} from "../execution-credentials.ts"
import {
  getRequiredProviderRequirementsForDeployment,
  getRequiredProvidersForDeployment,
} from "../provider-requirements.ts"
import { withSpan } from "../telemetry.ts"

type SerializableDependencyGraph = {
  workspaces: string[]
  edges: [string, string][]
}

export interface EnvironmentGroupProjectionSourceMetadata {
  prNumber?: number | null
  authorGithubId?: number | null
  authorLogin?: string | null
}

export interface EnvironmentGroupProjectionWorkspacePayload {
  deploymentId: string
  runGroupId: string | null
  workspacePath: string
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  approvers: string[] | null
  createdAt: string
  headUpdatedAt: string
  headSha: string
  authorGithubId: number | null
  authorLogin: string | null
  connectionStatus: "ready" | "missing" | "conflict" | "not_required"
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{ id: string; name: string; provider: string }>
  blockedReason: string | null
  degradation: WorkspaceDegradation | null
  lastRunId: string | null
  lastRunType: string | null
  lastRunStatus: string | null
  lastRunCompletedAt: string | null
  planSummary: string | null
}

export interface EnvironmentGroupProjectionPayload {
  repo: string
  environmentKind: string
  environmentName: string
  activeRunGroupId?: string | null
  sourceKind: string | null
  sourceMetadata: EnvironmentGroupProjectionSourceMetadata | null
  ref: string
  headSha: string
  status: string
  updatedAt: string
  dependencyGraph: SerializableDependencyGraph | null
  workspaces: EnvironmentGroupProjectionWorkspacePayload[]
}

export function parseEnvironmentGroupProjectionPayload(
  value: unknown,
): EnvironmentGroupProjectionPayload | null {
  if (typeof value !== "object" || value === null) {
    return null
  }

  return value as EnvironmentGroupProjectionPayload
}

function normalizeApprovers(value: unknown): string[] | null {
  const approvers = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []

  return approvers.length > 0 ? approvers : null
}

function aggregateStatus(workspaces: Array<{ status: string }>): string {
  const statuses = new Set(workspaces.map((workspace) => workspace.status))
  if (statuses.has("failed")) return "failed"
  if (
    statuses.has("applying") ||
    statuses.has("activating") ||
    statuses.has("planning") ||
    statuses.has("destroying")
  ) {
    return "in_progress"
  }
  if (statuses.has("ready")) return "ready"
  if (statuses.has("destroyed")) return "destroyed"
  return "pending"
}

function activeRunGroupIdForWorkspaces(
  workspaces: Array<{ status: string; runGroupId: string | null; headUpdatedAt: string }>,
): string | null {
  const activeWorkspaces = workspaces
    .filter((workspace) => workspace.runGroupId && isActiveWorkspaceStatus(workspace.status))
    .sort((left, right) => right.headUpdatedAt.localeCompare(left.headUpdatedAt))

  return activeWorkspaces[0]?.runGroupId ?? null
}

function isActiveWorkspaceStatus(status: string): boolean {
  return ["planning", "applying", "activating", "destroying", "running"].includes(status)
}

function getSourceMetadataForDeployment(deployment: WorkspaceDeployment): {
  sourceKind: string | null
  sourceMetadata: EnvironmentGroupProjectionSourceMetadata | null
} {
  if (deployment.environmentKind !== "transient") {
    return {
      sourceKind: null,
      sourceMetadata: null,
    }
  }

  if (deployment.prNumber != null) {
    return {
      sourceKind: "github_pull_request",
      sourceMetadata: {
        prNumber: deployment.prNumber,
        authorGithubId: deployment.authorGithubId ?? null,
        authorLogin: deployment.authorLogin ?? null,
      },
    }
  }

  return {
    sourceKind: "transient",
    sourceMetadata: {
      authorGithubId: deployment.authorGithubId ?? null,
      authorLogin: deployment.authorLogin ?? null,
    },
  }
}

export async function buildEnvironmentGroupProjectionRows(params: {
  orgId: string
  repo?: string
  environmentKind?: "named" | "transient"
}): Promise<NewEnvironmentGroupProjection[]> {
  return withSpan("projections.build_environment_groups", async (span) => {
    span.setAttributes({
      "yaffle.org_id": params.orgId,
      "yaffle.repo": params.repo ?? "",
      "projections.environment_kind": params.environmentKind ?? "all",
    })

    const latestDeployments = await listLatestDeploymentsForOrg(params.orgId)
    const activeDeployments = latestDeployments.filter((deployment) => {
      if (deployment.status === "destroyed") {
        return false
      }
      if (params.repo && deployment.repo !== params.repo) {
        return false
      }
      if (params.environmentKind && deployment.environmentKind !== params.environmentKind) {
        return false
      }
      return true
    })

    if (activeDeployments.length === 0) {
      return []
    }

    const deploymentIds = activeDeployments.map((deployment) => deployment.id)
    const runGroupIds = [
      ...new Set(
        activeDeployments
          .map((deployment) => deployment.runGroupId)
          .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
      ),
    ]

    const [
      applyRunsMap,
      allRunsMap,
      orgConnections,
      metadataByRunGroupWorkspaceKey,
      dependencyGraphs,
    ] = await Promise.all([
      findLatestRunsForDeployments(deploymentIds, "apply"),
      findLatestRunsForDeployments(deploymentIds),
      listConnectionsForOrg(params.orgId),
      findRunGroupWorkspaceMetadataForRunGroups(runGroupIds),
      getLatestDependencyGraphsForOrg(params.orgId, params.repo),
    ])

    const groups = new Map<string, EnvironmentGroupProjectionPayload>()

    for (const deployment of activeDeployments) {
      const readiness = await getConnectionReadinessForDeploymentWithDeps(deployment, {
        getProvidersForDeployment: getRequiredProvidersForDeployment,
        getProviderRequirementsForDeployment: (currentDeployment) =>
          getRequiredProviderRequirementsForDeployment(currentDeployment, {
            metadata: currentDeployment.runGroupId
              ? (metadataByRunGroupWorkspaceKey.get(
                  buildRunGroupWorkspaceMetadataKey(
                    currentDeployment.runGroupId,
                    currentDeployment.workspacePath,
                  ),
                ) ?? null)
              : null,
          }),
        listConnectionsForOrg: async () => orgConnections,
        resolveConnectionEnv: async () => ({}),
      })

      const latestApply = applyRunsMap.get(deployment.id)
      const latestRun = latestApply ?? allRunsMap.get(deployment.id)
      const groupKey = `${deployment.repo}:${deployment.environmentKind}:${deployment.environmentName}`
      const dependencyGraph =
        dependencyGraphs.get(`${deployment.repo}:${deployment.environmentName}`) ?? null
      const { sourceKind, sourceMetadata } = getSourceMetadataForDeployment(deployment)

      const workspacePayload: EnvironmentGroupProjectionWorkspacePayload = {
        deploymentId: deployment.id,
        runGroupId: deployment.runGroupId ?? null,
        workspacePath: deployment.workspacePath,
        status: deployment.status,
        stateKey: deployment.stateKey,
        mode: deployment.mode,
        requireApproval: deployment.requireApproval,
        approvers: normalizeApprovers(deployment.approvers),
        createdAt: deployment.createdAt.toISOString(),
        headUpdatedAt: deployment.statusChangedAt.toISOString(),
        headSha: deployment.headSha,
        authorGithubId: deployment.authorGithubId ?? null,
        authorLogin: deployment.authorLogin ?? null,
        connectionStatus: readiness.status,
        missingProviders: readiness.missingProviders,
        conflictProviders: readiness.conflictProviders,
        matchedConnections: readiness.matchedConnections,
        blockedReason: formatConnectionBlockedReason(readiness),
        degradation: readiness.degradation ?? null,
        lastRunId: latestRun?.id ?? null,
        lastRunType: latestRun?.runType ?? null,
        lastRunStatus: latestRun?.status ?? null,
        lastRunCompletedAt: latestRun?.completedAt?.toISOString() ?? null,
        planSummary: latestRun?.planSummary ?? null,
      }

      const existing = groups.get(groupKey)
      if (!existing) {
        groups.set(groupKey, {
          repo: deployment.repo,
          environmentKind: deployment.environmentKind,
          environmentName: deployment.environmentName,
          sourceKind,
          sourceMetadata,
          ref: deployment.ref,
          headSha: deployment.headSha,
          status: aggregateStatus([workspacePayload]),
          activeRunGroupId: activeRunGroupIdForWorkspaces([workspacePayload]),
          updatedAt: deployment.statusChangedAt.toISOString(),
          dependencyGraph,
          workspaces: [workspacePayload],
        })
        continue
      }

      existing.workspaces.push(workspacePayload)
      existing.status = aggregateStatus(existing.workspaces)
      existing.activeRunGroupId = activeRunGroupIdForWorkspaces(existing.workspaces)
      const candidateUpdatedAt = deployment.statusChangedAt.toISOString()
      if (candidateUpdatedAt > existing.updatedAt) {
        existing.updatedAt = candidateUpdatedAt
        existing.headSha = deployment.headSha
        existing.ref = deployment.ref
      }
    }

    const rebuiltAt = new Date()
    const rows: NewEnvironmentGroupProjection[] = []

    for (const payload of groups.values()) {
      payload.workspaces.sort((left, right) =>
        left.workspacePath.localeCompare(right.workspacePath),
      )

      const blockedWorkspaceCount = payload.workspaces.filter(
        (workspace) => workspace.blockedReason !== null,
      ).length
      const degradedWorkspaceCount = payload.workspaces.filter(
        (workspace) => workspace.degradation !== null,
      ).length

      rows.push({
        orgId: params.orgId,
        repo: payload.repo,
        environmentKind: payload.environmentKind,
        environmentName: payload.environmentName,
        sourceKind: payload.sourceKind,
        sourceMetadata: payload.sourceMetadata,
        status: payload.status,
        headSha: payload.headSha,
        updatedAt: new Date(payload.updatedAt),
        workspaceCount: payload.workspaces.length,
        blockedWorkspaceCount,
        degradedWorkspaceCount,
        version: 2,
        payload,
        rebuiltAt,
        rebuildError: null,
        rowUpdatedAt: rebuiltAt,
      })
    }

    span.setAttributes({
      "projections.group_count": rows.length,
      "projections.workspace_count": rows.reduce(
        (total, row) => total + (row.workspaceCount ?? 0),
        0,
      ),
    })

    return rows
  })
}

export async function rebuildEnvironmentGroupProjections(params: {
  orgId: string
  repo?: string
  environmentKind?: "named" | "transient"
}): Promise<number> {
  const rows = await buildEnvironmentGroupProjectionRows(params)
  const existing = await listEnvironmentGroupProjections({
    orgId: params.orgId,
    repo: params.repo,
    environmentKind: params.environmentKind,
  })

  const nextKeys = new Set(
    rows.map((row) => `${row.orgId}:${row.repo}:${row.environmentKind}:${row.environmentName}`),
  )

  await deleteEnvironmentGroupProjectionsByIds(
    existing
      .filter(
        (row) =>
          !nextKeys.has(`${row.orgId}:${row.repo}:${row.environmentKind}:${row.environmentName}`),
      )
      .map((row) => row.id),
  )

  await upsertEnvironmentGroupProjections(rows)
  return rows.length
}
