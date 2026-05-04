import type {
  DependencyGraph,
  EnvironmentLifecycleSummary,
  LifecycleItemSummary,
  WorkspaceWithRuns,
} from "$lib/api"

export type PreviewDagNode = PreviewWorkspaceDagNode | PreviewLifecycleDagNode

export interface PreviewWorkspaceDagNode {
  id: string
  kind: "workspace"
  workspacePath: string
  workspace: WorkspaceWithRuns | null
}

export interface PreviewLifecycleDagNode {
  id: string
  kind: "lifecycle"
  workspacePath: string
  workspace: WorkspaceWithRuns | null
  phase: string
  key: string
  item: LifecycleItemSummary
}

const PHASE_RANK: Record<string, number> = {
  activation: 0,
  verification: 1,
}

export function lifecycleNodeId(workspacePath: string, phase: string, key: string): string {
  return `${workspacePath}::${phase}::${key}`
}

export function parseLifecycleNodeId(nodeId: string): {
  workspacePath: string
  phase: string
  key: string
} | null {
  const parts = nodeId.split("::")
  if (parts.length !== 3) {
    return null
  }

  const [workspacePath, phase, key] = parts
  if (!workspacePath || !phase || !key) {
    return null
  }

  return { workspacePath, phase, key }
}

export function buildPreviewDag(params: {
  workspaces: WorkspaceWithRuns[]
  dependencyGraph: DependencyGraph | null
  lifecycle: EnvironmentLifecycleSummary | null
}): {
  nodes: PreviewDagNode[]
  dependencyGraph: DependencyGraph | null
} {
  const workspaceByPath = new Map(
    params.workspaces.map((workspace) => [workspace.preview.workspacePath, workspace]),
  )
  const workspaceOrder = dedupePreservingOrder([
    ...(params.dependencyGraph?.workspaces ?? []),
    ...params.workspaces.map((workspace) => workspace.preview.workspacePath),
    ...(params.lifecycle?.items.map((item) => item.workspacePath) ?? []),
  ])

  const nodesById = new Map<string, PreviewDagNode>(
    workspaceOrder.map((workspacePath) => [
      workspacePath,
      {
        id: workspacePath,
        kind: "workspace",
        workspacePath,
        workspace: workspaceByPath.get(workspacePath) ?? null,
      } satisfies PreviewWorkspaceDagNode,
    ]),
  )

  if (!params.lifecycle || params.lifecycle.items.length === 0) {
    return {
      nodes: workspaceOrder
        .map((workspacePath) => nodesById.get(workspacePath))
        .filter((node): node is PreviewDagNode => node != null),
      dependencyGraph: params.dependencyGraph ?? {
        workspaces: workspaceOrder,
        edges: [],
      },
    }
  }

  const lifecycleItemsByWorkspace = new Map<string, LifecycleItemSummary[]>()
  for (const item of [...params.lifecycle.items].sort(compareLifecycleItems)) {
    const existing = lifecycleItemsByWorkspace.get(item.workspacePath)
    if (existing) {
      existing.push(item)
    } else {
      lifecycleItemsByWorkspace.set(item.workspacePath, [item])
    }
  }

  const graphWorkspaces: string[] = []
  const graphEdges = [...(params.dependencyGraph?.edges ?? [])]

  for (const workspacePath of workspaceOrder) {
    graphWorkspaces.push(workspacePath)
    const workspaceLifecycleItems = lifecycleItemsByWorkspace.get(workspacePath) ?? []
    const activationIds = workspaceLifecycleItems
      .filter((item) => item.phase === "activation")
      .map((item) => lifecycleNodeId(item.workspacePath, item.phase, item.key))

    for (const item of workspaceLifecycleItems) {
      const nodeId = lifecycleNodeId(item.workspacePath, item.phase, item.key)
      nodesById.set(nodeId, {
        id: nodeId,
        kind: "lifecycle",
        workspacePath: item.workspacePath,
        workspace: workspaceByPath.get(item.workspacePath) ?? null,
        phase: item.phase,
        key: item.key,
        item,
      })
      graphWorkspaces.push(nodeId)

      const dependencies = item.phase === "verification" && activationIds.length > 0
        ? activationIds
        : [workspacePath]
      for (const dependency of dependencies) {
        graphEdges.push([nodeId, dependency])
      }
    }
  }

  return {
    nodes: graphWorkspaces
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is PreviewDagNode => node != null),
    dependencyGraph: {
      workspaces: graphWorkspaces,
      edges: dedupeEdges(graphEdges),
    },
  }
}

function compareLifecycleItems(left: LifecycleItemSummary, right: LifecycleItemSummary): number {
  const workspaceOrder = left.workspacePath.localeCompare(right.workspacePath)
  if (workspaceOrder !== 0) {
    return workspaceOrder
  }

  const phaseOrder = (PHASE_RANK[left.phase] ?? 99) - (PHASE_RANK[right.phase] ?? 99)
  if (phaseOrder !== 0) {
    return phaseOrder
  }

  return left.key.localeCompare(right.key)
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    ordered.push(value)
  }

  return ordered
}

function dedupeEdges(edges: Array<[string, string]>): Array<[string, string]> {
  const seen = new Set<string>()
  const ordered: Array<[string, string]> = []

  for (const [dependent, dependency] of edges) {
    const key = `${dependent}-->${dependency}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    ordered.push([dependent, dependency])
  }

  return ordered
}
