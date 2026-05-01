import type { EnvironmentGroup, WorkspaceDegradation } from "$lib/api"

type WorkspaceWithOptionalDegradation = {
  workspacePath: string
  degradation?: WorkspaceDegradation | null
}

export interface EnvironmentDegradationGroup {
  message: string
  errorKind: WorkspaceDegradation["errorKind"]
  retryable: boolean
  workspaces: string[]
}

export interface EnvironmentDegradationSummary {
  totalWorkspaces: number
  groups: EnvironmentDegradationGroup[]
}

export function getWorkspaceDegradationMessage(
  workspace: Pick<WorkspaceWithOptionalDegradation, "degradation">,
): string | null {
  const message = workspace.degradation?.message?.trim()
  return message && message.length > 0 ? message : null
}

export function getDegradedWorkspaces<T extends WorkspaceWithOptionalDegradation>(workspaces: T[]): Array<T & {
  degradation: WorkspaceDegradation
}> {
  return workspaces.filter((workspace): workspace is T & { degradation: WorkspaceDegradation } =>
    workspace.degradation != null && getWorkspaceDegradationMessage(workspace) != null,
  )
}

export function summarizeEnvironmentDegradation(
  environment: EnvironmentGroup,
): EnvironmentDegradationSummary | null {
  const degraded = getDegradedWorkspaces(environment.workspaces)
  if (degraded.length === 0) {
    return null
  }

  const grouped = new Map<string, EnvironmentDegradationGroup>()

  for (const workspace of degraded) {
    const message = getWorkspaceDegradationMessage(workspace)
    if (!message) {
      continue
    }

    const key = `${workspace.degradation.errorKind}:${message}`
    const existing = grouped.get(key)
    if (existing) {
      existing.workspaces.push(workspace.workspacePath)
      continue
    }

    grouped.set(key, {
      message,
      errorKind: workspace.degradation.errorKind,
      retryable: workspace.degradation.retryable,
      workspaces: [workspace.workspacePath],
    })
  }

  return {
    totalWorkspaces: degraded.length,
    groups: [...grouped.values()].map((group) => ({
      ...group,
      workspaces: [...group.workspaces].sort(),
    })),
  }
}

export function countDegradedEnvironments(environments: EnvironmentGroup[]): number {
  return environments.filter((environment) => summarizeEnvironmentDegradation(environment) !== null).length
}
