import type { DependencyGraph } from "./api"

export interface CliAlignedColumnsResult<T> {
  columns: T[][]
  topologicalOrder: string[]
  stages: Map<string, number>
}

export interface OrthogonalEdgeRouteInput {
  edgeId: string
  sourceId: string
  targetId: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  bendX: number
}

interface HorizontalSegment {
  edgeId: string
  y: number
  startX: number
  endX: number
}

interface VerticalSegment {
  edgeId: string
  x: number
  startY: number
  endY: number
}

const BRIDGE_HALF_WIDTH = 6
const BRIDGE_HEIGHT = 7

export function computeCliAlignedColumns<T>(
  items: T[],
  getId: (item: T) => string,
  dependencyGraph: DependencyGraph | null,
  horizontalFirst = false,
): CliAlignedColumnsResult<T> {
  if (!dependencyGraph || dependencyGraph.edges.length === 0) {
    const sorted = [...items].sort((a, b) => getId(a).localeCompare(getId(b)))

    return {
      columns: horizontalFirst ? sorted.map((item) => [item]) : [sorted],
      topologicalOrder: sorted.map((item) => getId(item)),
      stages: new Map(sorted.map((item) => [getId(item), 0])),
    }
  }

  const itemById = new Map(items.map((item) => [getId(item), item]))
  const candidateIds = dedupePreservingOrder([
    ...dependencyGraph.workspaces,
    ...items.map((item) => getId(item)),
  ])
  const topologicalOrder = computeCliTopologicalOrder(dependencyGraph, candidateIds)
  const stages = computeCliStages(dependencyGraph, topologicalOrder)
  const maxStage = Math.max(...Array.from(stages.values()), 0)
  const columns: T[][] = Array.from({ length: maxStage + 1 }, () => [])

  for (const workspacePath of topologicalOrder) {
    const item = itemById.get(workspacePath)
    if (!item) continue

    const stage = stages.get(workspacePath) ?? 0
    columns[stage].push(item)
  }

  for (const item of items) {
    const workspacePath = getId(item)
    if (topologicalOrder.includes(workspacePath)) continue

    columns[0].push(item)
  }

  return {
    columns,
    topologicalOrder,
    stages,
  }
}

export function buildOrthogonalEdgePaths(edges: OrthogonalEdgeRouteInput[]): Map<string, string> {
  const horizontalSegments: HorizontalSegment[] = []
  const verticalSegments: VerticalSegment[] = []

  for (const edge of edges) {
    if (edge.sourceY === edge.targetY || edge.bendX <= edge.sourceX || edge.bendX >= edge.targetX) {
      horizontalSegments.push({
        edgeId: edge.edgeId,
        y: edge.sourceY,
        startX: edge.sourceX,
        endX: edge.targetX,
      })
      continue
    }

    horizontalSegments.push({
      edgeId: edge.edgeId,
      y: edge.sourceY,
      startX: edge.sourceX,
      endX: edge.bendX,
    })
    horizontalSegments.push({
      edgeId: edge.edgeId,
      y: edge.targetY,
      startX: edge.bendX,
      endX: edge.targetX,
    })
    verticalSegments.push({
      edgeId: edge.edgeId,
      x: edge.bendX,
      startY: Math.min(edge.sourceY, edge.targetY),
      endY: Math.max(edge.sourceY, edge.targetY),
    })
  }

  const edgeCrossings = new Map<string, number[]>()
  for (const segment of horizontalSegments) {
    const crossings = verticalSegments
      .filter((vertical) => vertical.edgeId !== segment.edgeId)
      .filter((vertical) => vertical.x > segment.startX && vertical.x < segment.endX)
      .filter((vertical) => segment.y > vertical.startY && segment.y < vertical.endY)
      .map((vertical) => vertical.x)
      .sort((left, right) => left - right)

    edgeCrossings.set(
      segmentKey(segment.edgeId, segment.y, segment.startX, segment.endX),
      crossings,
    )
  }

  return new Map(
    edges.map((edge) => {
      const path = buildOrthogonalEdgePath(edge, edgeCrossings)
      return [edge.edgeId, path]
    }),
  )
}

function buildOrthogonalEdgePath(
  edge: OrthogonalEdgeRouteInput,
  edgeCrossings: Map<string, number[]>,
): string {
  const commands = [`M ${edge.sourceX} ${edge.sourceY}`]

  if (edge.sourceY === edge.targetY || edge.bendX <= edge.sourceX || edge.bendX >= edge.targetX) {
    commands.push(
      horizontalPathCommand(
        edge.sourceY,
        edge.sourceX,
        edge.targetX,
        edgeCrossings.get(segmentKey(edge.edgeId, edge.sourceY, edge.sourceX, edge.targetX)) ?? [],
      ),
    )
    return commands.join(" ")
  }

  commands.push(
    horizontalPathCommand(
      edge.sourceY,
      edge.sourceX,
      edge.bendX,
      edgeCrossings.get(segmentKey(edge.edgeId, edge.sourceY, edge.sourceX, edge.bendX)) ?? [],
    ),
  )
  commands.push(`L ${edge.bendX} ${edge.targetY}`)
  commands.push(
    horizontalPathCommand(
      edge.targetY,
      edge.bendX,
      edge.targetX,
      edgeCrossings.get(segmentKey(edge.edgeId, edge.targetY, edge.bendX, edge.targetX)) ?? [],
    ),
  )

  return commands.join(" ")
}

function horizontalPathCommand(
  y: number,
  startX: number,
  endX: number,
  crossings: number[],
): string {
  if (crossings.length === 0) {
    return `L ${endX} ${y}`
  }

  const commands: string[] = []
  let currentX = startX

  for (const crossingX of crossings) {
    const bridgeStart = Math.max(currentX, crossingX - BRIDGE_HALF_WIDTH)
    if (bridgeStart > currentX) {
      commands.push(`L ${bridgeStart} ${y}`)
    }

    const bridgePeakLeft = crossingX - BRIDGE_HALF_WIDTH / 2
    const bridgePeakRight = crossingX + BRIDGE_HALF_WIDTH / 2
    const bridgeEnd = crossingX + BRIDGE_HALF_WIDTH

    commands.push(
      `C ${bridgePeakLeft} ${y} ${bridgePeakLeft} ${y - BRIDGE_HEIGHT} ${crossingX} ${y - BRIDGE_HEIGHT}`,
    )
    commands.push(
      `C ${bridgePeakRight} ${y - BRIDGE_HEIGHT} ${bridgePeakRight} ${y} ${bridgeEnd} ${y}`,
    )

    currentX = bridgeEnd
  }

  if (currentX < endX) {
    commands.push(`L ${endX} ${y}`)
  }

  return commands.join(" ")
}

function computeCliTopologicalOrder(
  dependencyGraph: DependencyGraph,
  candidateIds: string[],
): string[] {
  const dependencies = new Map<string, string[]>()
  for (const [dependent, dependency] of dependencyGraph.edges) {
    const existing = dependencies.get(dependent)
    if (existing) {
      existing.push(dependency)
      continue
    }

    dependencies.set(dependent, [dependency])
  }

  const orderedSeeds = dedupePreservingOrder([
    ...dependencyGraph.workspaces,
    ...candidateIds,
    ...dependencyGraph.edges.flatMap(([dependent, dependency]) => [dependent, dependency]),
  ])
  const visited = new Set<string>()
  const order: string[] = []

  const visit = (workspacePath: string) => {
    if (visited.has(workspacePath)) {
      return
    }

    visited.add(workspacePath)
    for (const dependency of dependencies.get(workspacePath) ?? []) {
      visit(dependency)
    }
    order.push(workspacePath)
  }

  for (const workspacePath of orderedSeeds) {
    visit(workspacePath)
  }

  return order
}

function computeCliStages(
  dependencyGraph: DependencyGraph,
  topologicalOrder: string[],
): Map<string, number> {
  const dependencies = new Map<string, string[]>()
  for (const [dependent, dependency] of dependencyGraph.edges) {
    const existing = dependencies.get(dependent)
    if (existing) {
      existing.push(dependency)
      continue
    }

    dependencies.set(dependent, [dependency])
  }

  const stages = new Map<string, number>()
  for (const workspacePath of topologicalOrder) {
    const stage = Math.max(
      0,
      ...(dependencies.get(workspacePath) ?? []).map(
        (dependency) => (stages.get(dependency) ?? 0) + 1,
      ),
    )
    stages.set(workspacePath, stage)
  }

  return stages
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }

  return result
}

function segmentKey(edgeId: string, y: number, startX: number, endX: number): string {
  return `${edgeId}:${y}:${startX}:${endX}`
}
