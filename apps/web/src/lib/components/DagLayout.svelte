<script lang="ts" module>
  import type { DependencyGraph } from "$lib/api"

  export interface DagNode<T> {
    id: string
    data: T
  }

  export interface DagPosition {
    col: number
    row: number
    x: number
    y: number
  }

  export interface DagEdge {
    sourceCol: number
    sourceRow: number
    targetCol: number
    targetRow: number
  }

  export interface DagLayoutInfo<T> {
    columns: DagNode<T>[][]
    positions: Map<string, DagPosition>
    edges: DagEdge[]
    columnWidths: number[]
    svgWidth: number
    svgHeight: number
  }
</script>

<script lang="ts" generics="T">
  import type { Snippet } from "svelte"

  interface Props {
    /** Items to layout in the DAG */
    items: T[]
    /** Get unique ID for an item */
    getId: (item: T) => string
    /** Dependency graph defining edges */
    dependencyGraph: DependencyGraph | null
    /** Estimate width needed for an item (for column sizing) */
    estimateWidth?: (item: T) => number
    /** Node height in pixels */
    nodeHeight?: number
    /** Gap between nodes horizontally */
    nodeGapX?: number
    /** Gap between nodes vertically */
    nodeGapY?: number
    /** Minimum column width */
    minColumnWidth?: number
    /** When true, independent items fill horizontal space first (row-major), otherwise vertical first (column-major) */
    horizontalFirst?: boolean
    /** Snippet to render each node */
    node: Snippet<[{ item: T; position: DagPosition; width: number; height: number }]>
  }

  let {
    items,
    getId,
    dependencyGraph,
    estimateWidth = () => 100,
    nodeHeight = 32,
    nodeGapX = 60,
    nodeGapY = 12,
    minColumnWidth = 80,
    horizontalFirst = false,
    node,
  }: Props = $props()

  /**
   * Compute the depth (column) for each item.
   * Depth 0 = no dependencies (roots), higher = further from roots.
   */
  function computeDepths(graph: DependencyGraph, itemIds: Set<string>): Map<string, number> {
    const depths = new Map<string, number>()
    const deps = new Map<string, Set<string>>()

    // Build dependency lookup (source depends on target)
    for (const [source, target] of graph.edges) {
      if (!deps.has(source)) deps.set(source, new Set())
      deps.get(source)!.add(target)
    }

    // Initialize all items at depth 0
    for (const id of itemIds) {
      depths.set(id, 0)
    }

    // Also include items from the graph that might not be in our items list yet
    for (const ws of graph.workspaces) {
      if (!depths.has(ws)) {
        depths.set(ws, 0)
      }
    }

    // Iteratively compute depths (depth = max(dep depths) + 1)
    let changed = true
    while (changed) {
      changed = false
      for (const id of depths.keys()) {
        const idDeps = deps.get(id)
        if (!idDeps || idDeps.size === 0) continue

        let maxDepth = 0
        for (const dep of idDeps) {
          const depDepth = depths.get(dep) ?? 0
          maxDepth = Math.max(maxDepth, depDepth)
        }

        const newDepth = maxDepth + 1
        if (newDepth !== depths.get(id)) {
          depths.set(id, newDepth)
          changed = true
        }
      }
    }

    return depths
  }

  /**
   * Group items by their depth into columns.
   */
  function groupByDepth<U>(
    itemList: U[],
    getItemId: (item: U) => string,
    depths: Map<string, number>
  ): U[][] {
    const maxDepth = Math.max(...Array.from(depths.values()), 0)
    const columns: U[][] = Array.from({ length: maxDepth + 1 }, () => [])

    for (const item of itemList) {
      const id = getItemId(item)
      const depth = depths.get(id) ?? 0
      columns[depth].push(item)
    }

    // Sort each column by ID for consistent ordering
    for (const col of columns) {
      col.sort((a, b) => getItemId(a).localeCompare(getItemId(b)))
    }

    return columns
  }

  // Compute columns layout
  const columns = $derived.by((): T[][] => {
    if (!dependencyGraph || dependencyGraph.edges.length === 0) {
      if (horizontalFirst) {
        // No dependencies + horizontal first - each item gets its own column (horizontal layout)
        const sorted = [...items].sort((a, b) => getId(a).localeCompare(getId(b)))
        return sorted.map(item => [item])
      }
      // No dependencies - single column with all items sorted (vertical layout)
      return [[...items].sort((a, b) => getId(a).localeCompare(getId(b)))]
    }

    const itemIds = new Set(items.map(getId))
    const depths = computeDepths(dependencyGraph, itemIds)
    return groupByDepth(items, getId, depths)
  })

  // Maximum rows across all columns
  const maxRows = $derived(Math.max(...columns.map((col) => col.length), 1))

  // Compute column widths (widest node in each column)
  const columnWidths = $derived(
    columns.map((col) => {
      const widths = col.map((item) => estimateWidth(item))
      return Math.max(...widths, minColumnWidth)
    })
  )

  // Compute column X positions
  const columnX = $derived.by(() => {
    const positions: number[] = []
    let x = nodeGapX
    for (let i = 0; i < columnWidths.length; i++) {
      positions.push(x)
      x += columnWidths[i] + nodeGapX
    }
    return positions
  })

  // SVG total dimensions
  const svgWidth = $derived(
    columnWidths.reduce((sum, w) => sum + w, 0) + nodeGapX * (columnWidths.length + 1)
  )
  const svgHeight = $derived(maxRows * (nodeHeight + nodeGapY) + nodeGapY)

  // Get node position
  function getNodeX(colIdx: number): number {
    return columnX[colIdx]
  }

  function getNodeY(rowIdx: number): number {
    return rowIdx * (nodeHeight + nodeGapY) + nodeGapY
  }

  // Build position map for all items
  const positions = $derived.by(() => {
    const posMap = new Map<string, DagPosition>()
    columns.forEach((col, colIdx) => {
      col.forEach((item, rowIdx) => {
        const id = getId(item)
        posMap.set(id, {
          col: colIdx,
          row: rowIdx,
          x: getNodeX(colIdx),
          y: getNodeY(rowIdx),
        })
      })
    })
    return posMap
  })

  // Get edges between adjacent columns for drawing
  const edges = $derived.by((): DagEdge[] => {
    if (!dependencyGraph || dependencyGraph.edges.length === 0) return []

    const result: DagEdge[] = []

    // Create edges (source depends on target, so arrow goes target -> source)
    for (const [source, target] of dependencyGraph.edges) {
      const sourcePos = positions.get(source)
      const targetPos = positions.get(target)
      if (sourcePos && targetPos) {
        result.push({
          sourceCol: targetPos.col,
          sourceRow: targetPos.row,
          targetCol: sourcePos.col,
          targetRow: sourcePos.row,
        })
      }
    }

    return result
  })

  // Generate edge path (bezier curve)
  function edgePath(edge: DagEdge): string {
    const x1 = getNodeX(edge.sourceCol) + columnWidths[edge.sourceCol]
    const y1 = getNodeY(edge.sourceRow) + nodeHeight / 2
    const x2 = getNodeX(edge.targetCol)
    const y2 = getNodeY(edge.targetRow) + nodeHeight / 2

    // Control points for bezier curve
    const midX = (x1 + x2) / 2

    return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
  }
</script>

<div class="dag-container overflow-x-auto">
  {#if columns.length === 0 || items.length === 0}
    <div class="text-text-dim text-xs text-center py-4">No items</div>
  {:else}
    <svg
      width={svgWidth}
      height={svgHeight}
      class="dag-svg"
      style="min-width: {svgWidth}px; min-height: {svgHeight}px;"
    >
      <!-- Semi-circle marker definition (left-facing, butts against node) -->
      <defs>
        <marker
          id="dag-endpoint"
          markerWidth="4"
          markerHeight="6"
          refX="4"
          refY="3"
          orient="auto"
        >
          <path d="M 4 0 A 3 3 0 0 0 4 6" fill="var(--color-border)" />
        </marker>
      </defs>

      <!-- Edges (drawn first so they're behind nodes) -->
      <g class="edges">
        {#each edges as edge}
          <path
            d={edgePath(edge)}
            fill="none"
            stroke="var(--color-border)"
            stroke-width="1.5"
            marker-end="url(#dag-endpoint)"
          />
        {/each}
      </g>

      <!-- Nodes by column -->
      <g class="nodes">
        {#each columns as column, colIdx}
          {#each column as item, rowIdx}
            {@const id = getId(item)}
            {@const pos = positions.get(id)!}
            {@const width = columnWidths[colIdx]}
            <g transform="translate({pos.x}, {pos.y})">
              {@render node({ item, position: pos, width, height: nodeHeight })}
            </g>
          {/each}
        {/each}
      </g>
    </svg>
  {/if}
</div>

<style>
  .dag-container {
    scrollbar-width: thin;
    padding: 0.25rem;
  }

  .dag-container::-webkit-scrollbar {
    height: 6px;
  }

  .dag-container::-webkit-scrollbar-track {
    background: transparent;
  }

  .dag-container::-webkit-scrollbar-thumb {
    background: var(--color-border);
    border-radius: 3px;
  }

  .dag-svg {
    display: block;
  }
</style>
