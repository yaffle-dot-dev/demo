import type {
  DependencyGraph,
  EnvironmentLifecycleSummary,
  LifecycleItemSummary,
  WorkspaceWithRuns,
} from "$lib/api"

export type PreviewDagNode = PreviewWorkspaceDagNode

export interface PreviewWorkspaceDagNode {
  id: string
  kind: "workspace"
  workspacePath: string
  workspace: WorkspaceWithRuns | null
  lifecycleItems: LifecycleItemSummary[]
}

const PHASE_RANK: Record<string, number> = {
  activation: 0,
  verification: 1,
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
        lifecycleItems: [],
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

  for (const workspacePath of workspaceOrder) {
    const node = nodesById.get(workspacePath)
    if (node?.kind === "workspace") {
      node.lifecycleItems = lifecycleItemsByWorkspace.get(workspacePath) ?? []
    }
  }

  return {
    nodes: workspaceOrder
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is PreviewDagNode => node != null),
    dependencyGraph: params.dependencyGraph ?? {
      workspaces: workspaceOrder,
      edges: [],
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
