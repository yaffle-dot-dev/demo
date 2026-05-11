import type { EnvironmentLifecycleSummary, WorkspaceWithRuns } from "$lib/api"

interface LifecycleVector {
  pending: number
  running: number
  succeeded: number
  degraded: number
  blocked: number
  failed: number
}

function emptyVector(): LifecycleVector {
  return {
    pending: 0,
    running: 0,
    succeeded: 0,
    degraded: 0,
    blocked: 0,
    failed: 0,
  }
}

function buildVector(items: Array<{ state: string }>): LifecycleVector {
  const vector = emptyVector()

  for (const item of items) {
    switch (item.state) {
      case "pending":
      case "running":
      case "succeeded":
      case "degraded":
      case "blocked":
      case "failed":
        vector[item.state] += 1
        break
      default:
        break
    }
  }

  return vector
}

function usableMet(vector: LifecycleVector): boolean {
  return vector.pending === 0
    && vector.running === 0
    && vector.blocked === 0
    && vector.failed === 0
}

function acceptableMet(vector: LifecycleVector): boolean {
  return vector.pending === 0
    && vector.running === 0
    && vector.degraded === 0
    && vector.blocked === 0
    && vector.failed === 0
}

export function deriveLifecycleAggregateStatus(params: {
  workspaces: WorkspaceWithRuns[]
  lifecycle: EnvironmentLifecycleSummary | null
}): "running" | "success" | "partial" | "failed" | null {
  if (!params.lifecycle || params.lifecycle.items.length === 0) {
    return null
  }

  for (const workspace of params.workspaces) {
    if (workspace.preview.status === "failed" || workspace.preview.status === "system_error") {
      return "failed"
    }

    if (["pending", "planning", "awaiting_apply", "applying", "awaiting_approval", "activating", "destroying"].includes(workspace.preview.status)) {
      return "running"
    }

    if (workspace.preview.status === "destroyed") {
      continue
    }

    const workspaceItems = params.lifecycle.items.filter((item) => item.workspacePath === workspace.preview.workspacePath)
    const usable = buildVector(workspaceItems.filter((item) => item.scopes.includes("usable")))
    if (!usableMet(usable)) {
      if (usable.failed > 0 || usable.blocked > 0) {
        return "failed"
      }
      return "running"
    }

    const acceptable = buildVector(workspaceItems.filter((item) => item.scopes.includes("acceptable")))
    if (!acceptableMet(acceptable)) {
      if (acceptable.failed > 0 || acceptable.blocked > 0) {
        return "failed"
      }
      if (acceptable.pending > 0 || acceptable.running > 0) {
        return "running"
      }
      return "partial"
    }
  }

  return "success"
}
