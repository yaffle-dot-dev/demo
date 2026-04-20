import type { DependencyGraph, WorkspaceWithRuns } from "$lib/api"

export function normalizeWorkspaceStatus(status: string): string {
  if (status === "awaiting_apply") {
    return "planned"
  }

  return status
}

export function getWorkspaceConnectionBlockReason(workspace: WorkspaceWithRuns): string | null {
  const explicitReason = workspace.preview.blockedReason?.trim()
  if (explicitReason) {
    return explicitReason
  }

  if (workspace.preview.connectionStatus === "missing") {
    if (workspace.preview.missingProviders.length > 0) {
      return `Missing connections: ${workspace.preview.missingProviders.join(", ")}`
    }

    return "Missing required connections"
  }

  if (workspace.preview.connectionStatus === "conflict") {
    if (workspace.preview.conflictProviders.length > 0) {
      return `Conflicting connections: ${workspace.preview.conflictProviders.join(", ")}`
    }

    return "Conflicting connections"
  }

  return null
}

export function getBlockingUpstreamWorkspacePaths(
  workspacePath: string,
  workspaces: WorkspaceWithRuns[],
  dependencyGraph: DependencyGraph | null,
): string[] {
  if (!dependencyGraph) {
    return []
  }

  const upstreamPaths = dependencyGraph.edges
    .filter(([source]) => source === workspacePath)
    .map(([, target]) => target)

  return upstreamPaths.filter((upstreamPath) => {
    const upstreamWorkspace = workspaces.find((workspace) => workspace.preview.workspacePath === upstreamPath)
    if (!upstreamWorkspace) {
      return false
    }

    return getWorkspaceConnectionBlockReason(upstreamWorkspace) !== null
  })
}

export function hasFailedUpstreamWorkspace(
  workspacePath: string,
  workspaces: WorkspaceWithRuns[],
  dependencyGraph: DependencyGraph | null,
): boolean {
  if (!dependencyGraph) {
    return false
  }

  const upstreamPaths = dependencyGraph.edges
    .filter(([source]) => source === workspacePath)
    .map(([, target]) => target)

  for (const upstreamPath of upstreamPaths) {
    const upstreamWorkspace = workspaces.find((workspace) => workspace.preview.workspacePath === upstreamPath)
    if (!upstreamWorkspace) {
      continue
    }

    const plan = upstreamWorkspace.runs.find((run) => run.runType === "plan")
    const apply = upstreamWorkspace.runs.find((run) => run.runType === "apply")

    if (plan?.status === "failed" || apply?.status === "failed") {
      return true
    }
  }

  return false
}

export function getWorkspaceDisplayStatus(params: {
  workspace: WorkspaceWithRuns
  workspaces: WorkspaceWithRuns[]
  dependencyGraph: DependencyGraph | null
  isViewingLatest: boolean
}): string {
  const { workspace, workspaces, dependencyGraph, isViewingLatest } = params
  const plan = workspace.runs.find((run) => run.runType === "plan")
  const apply = workspace.runs.find((run) => run.runType === "apply")

  if (apply?.status === "success" || apply?.status === "skipped") return "ready"
  if (apply?.status === "running") return "applying"
  if (apply?.status === "failed") return "failed"
  if (apply?.status === "cancelled") return "cancelled"

  if (plan?.status === "success") return "planned"
  if (plan?.status === "running") return "planning"
  if (plan?.status === "failed") return "failed"
  if (plan?.status === "cancelled") return "cancelled"
  if (plan?.status === "pending") return "pending"

  if (workspace.runs.length === 0) {
    if (isViewingLatest) {
      return normalizeWorkspaceStatus(workspace.preview.status)
    }

    if (hasFailedUpstreamWorkspace(workspace.preview.workspacePath, workspaces, dependencyGraph)) {
      return "ready"
    }

    return "pending"
  }

  return normalizeWorkspaceStatus(workspace.preview.status)
}

export function isWorkspaceActivelyRunningStatus(status: string): boolean {
  return status === "planning" || status === "applying" || status === "destroying"
}

export function isWorkspaceInProgressStatus(status: string): boolean {
  return status === "queued"
    || status === "pending"
    || status === "planning"
    || status === "applying"
    || status === "awaiting_approval"
    || status === "destroying"
}
