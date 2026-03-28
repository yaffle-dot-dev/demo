<script lang="ts" module>
  import type { DependencyGraph } from "$lib/api"

  export type LayoutMode = "alphabetical" | "flexible"

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
    sourceId: string
    targetId: string
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
    /** Layout algorithm mode */
    layoutMode?: LayoutMode
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
    layoutMode = "flexible",
    node,
  }: Props = $props()

  // Top padding inside SVG (smaller than inter-node gap to reduce dead space)
  const svgPadTop = 4

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
   * Group items by their depth into columns with alphabetical ordering.
   */
  function groupByDepthAlphabetical<U>(
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

  // Store for flexible layout Y positions  
  let flexibleYPositions: Map<string, number> | null = null

  /**
   * Compute flexible Y positions that avoid edge-node crossings.
   * 
   * Simple approach: For nodes connected by long edges (spanning multiple columns),
   * center BOTH the source and target nodes vertically relative to the intermediate
   * column(s). This ensures bezier curves pass through the gaps between intermediate
   * nodes rather than through them.
   * 
   * Algorithm:
   * 1. Start with grid layout for all nodes
   * 2. Find long edges (spanning 2+ columns)
   * 3. For each long edge, compute the vertical center of intermediate columns
   * 4. Offset both source and target to align with that center
   */
  function computeFlexibleYPositions<U>(
    cols: U[][],
    getItemId: (item: U) => string,
    graph: DependencyGraph,
    nodeH: number,
    gapY: number
  ): Map<string, number> {
    const yPositions = new Map<string, number>()
    const minSpacing = nodeH + gapY

    // Build column lookup
    const nodeColumn = new Map<string, number>()
    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
      for (const item of cols[colIdx]) {
        nodeColumn.set(getItemId(item), colIdx)
      }
    }

    // Step 1: Initialize all nodes with grid positions
    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
      for (let rowIdx = 0; rowIdx < cols[colIdx].length; rowIdx++) {
        const id = getItemId(cols[colIdx][rowIdx])
        yPositions.set(id, svgPadTop + rowIdx * minSpacing)
      }
    }

    // Step 2: Find long edges and the intermediate columns they span
    const longEdges: Array<{
      sourceId: string
      targetId: string
      sourceCol: number
      targetCol: number
      intermediateCols: number[]
    }> = []

    for (const [dependent, dependency] of graph.edges) {
      const sourceCol = nodeColumn.get(dependency)
      const targetCol = nodeColumn.get(dependent)
      if (sourceCol === undefined || targetCol === undefined) continue

      const colSpan = targetCol - sourceCol
      if (colSpan > 1) {
        const intermediateCols: number[] = []
        for (let col = sourceCol + 1; col < targetCol; col++) {
          intermediateCols.push(col)
        }
        longEdges.push({
          sourceId: dependency,
          targetId: dependent,
          sourceCol,
          targetCol,
          intermediateCols,
        })
      }
    }

    if (longEdges.length === 0) {
      return yPositions
    }

    // Step 3: For each long edge, compute the vertical span of intermediate columns
    // and adjust source/target to center relative to that span
    for (const edge of longEdges) {
      // Find min/max Y of all nodes in intermediate columns
      let minY = Infinity
      let maxY = -Infinity

      for (const colIdx of edge.intermediateCols) {
        for (const item of cols[colIdx]) {
          const y = yPositions.get(getItemId(item))
          if (y !== undefined) {
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y + nodeH)
          }
        }
      }

      if (minY === Infinity) continue

      // The center Y where edges should pass through
      const centerY = (minY + maxY) / 2

      // For a bezier curve, if both source and target are at centerY,
      // the entire curve will be at centerY (a horizontal line through the center)
      // This ensures the edge passes through the vertical center of intermediate columns
      
      // Adjust source node position
      const sourceY = yPositions.get(edge.sourceId)
      if (sourceY !== undefined) {
        // Move source so its center aligns with the intermediate center
        const newSourceY = centerY - nodeH / 2
        yPositions.set(edge.sourceId, Math.max(svgPadTop, newSourceY))
      }

      // Adjust target node position
      const targetY = yPositions.get(edge.targetId)
      if (targetY !== undefined) {
        // Move target so its center aligns with the intermediate center
        const newTargetY = centerY - nodeH / 2
        yPositions.set(edge.targetId, Math.max(svgPadTop, newTargetY))
      }
    }

    // Step 4: Resolve any overlaps within columns caused by adjustments
    // For each column, ensure nodes don't overlap
    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
      const col = cols[colIdx]
      if (col.length <= 1) continue

      // Get current positions for this column
      const colNodes = col.map(item => ({
        id: getItemId(item),
        y: yPositions.get(getItemId(item)) ?? 0,
      }))

      // Sort by current Y position
      colNodes.sort((a, b) => a.y - b.y)

      // Ensure minimum spacing between consecutive nodes
      for (let i = 1; i < colNodes.length; i++) {
        const prevBottom = colNodes[i - 1].y + nodeH
        const currTop = colNodes[i].y
        if (currTop < prevBottom + gapY) {
          // Push this node down
          colNodes[i].y = prevBottom + gapY
          yPositions.set(colNodes[i].id, colNodes[i].y)
        }
      }
    }

    // Step 5: Compact upward — shift all nodes so the topmost starts at svgPadTop.
    // Steps 3-4 can push nodes far down, leaving a large empty gap at the top.
    let globalMinY = Infinity
    for (const y of yPositions.values()) {
      globalMinY = Math.min(globalMinY, y)
    }
    if (globalMinY > svgPadTop && globalMinY !== Infinity) {
      const shift = globalMinY - svgPadTop
      for (const [id, y] of yPositions) {
        yPositions.set(id, y - shift)
      }
    }

    return yPositions
  }

  // Compute columns layout
  const columns = $derived.by((): T[][] => {
    // Reset flexible positions when recomputing columns
    flexibleYPositions = null

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

    switch (layoutMode) {
      case "flexible": {
        // For flexible layout, use alphabetical ordering for columns
        // then compute flexible Y positions to avoid edge-node crossings
        const cols = groupByDepthAlphabetical(items, getId, depths)
        flexibleYPositions = computeFlexibleYPositions(cols, getId, dependencyGraph, nodeHeight, nodeGapY)
        return cols
      }

      case "alphabetical":
      default:
        return groupByDepthAlphabetical(items, getId, depths)
    }
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

  // For flexible layout, compute max Y from actual positions
  const svgHeight = $derived.by(() => {
    if (layoutMode === "flexible" && flexibleYPositions) {
      let maxY = 0
      for (const y of flexibleYPositions.values()) {
        maxY = Math.max(maxY, y)
      }
      return maxY + nodeHeight + nodeGapY
    }
    return maxRows * (nodeHeight + nodeGapY) + svgPadTop
  })

  // Get node position
  function getNodeX(colIdx: number): number {
    return columnX[colIdx]
  }

  function getNodeY(rowIdx: number): number {
    return rowIdx * (nodeHeight + nodeGapY) + svgPadTop
  }

  // Build position map for all items
  const positions = $derived.by(() => {
    const posMap = new Map<string, DagPosition>()
    columns.forEach((col, colIdx) => {
      col.forEach((item, rowIdx) => {
        const id = getId(item)

        // Use flexible Y position if available
        let y: number
        if (layoutMode === "flexible" && flexibleYPositions) {
          y = flexibleYPositions.get(id) ?? getNodeY(rowIdx)
        } else {
          y = getNodeY(rowIdx)
        }

        posMap.set(id, {
          col: colIdx,
          row: rowIdx,
          x: getNodeX(colIdx),
          y,
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
    // In our convention: edge goes FROM the dependency TO the dependent
    // So if [A, B] means "A depends on B", the visual edge goes B -> A
    for (const [dependent, dependency] of dependencyGraph.edges) {
      const dependentPos = positions.get(dependent)
      const dependencyPos = positions.get(dependency)
      if (dependentPos && dependencyPos) {
        result.push({
          sourceCol: dependencyPos.col,
          sourceRow: dependencyPos.row,
          targetCol: dependentPos.col,
          targetRow: dependentPos.row,
          sourceId: dependency,
          targetId: dependent,
        })
      }
    }

    return result
  })

  // Generate edge path - simple bezier curve for all edges
  function edgePath(edge: DagEdge): string {
    const sourcePos = positions.get(edge.sourceId)
    const targetPos = positions.get(edge.targetId)

    const x1 = getNodeX(edge.sourceCol) + columnWidths[edge.sourceCol]
    const y1 = (sourcePos?.y ?? getNodeY(edge.sourceRow)) + nodeHeight / 2
    const x2 = getNodeX(edge.targetCol)
    const y2 = (targetPos?.y ?? getNodeY(edge.targetRow)) + nodeHeight / 2

    // Simple bezier curve - the flexible layout positions nodes so this works
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
    padding: 0 0.25rem 0.25rem;
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
