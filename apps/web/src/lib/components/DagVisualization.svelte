<script lang="ts">
  import type { WorkspaceWithRuns, DependencyGraph, Run } from "$lib/api"

  interface Props {
    workspaces: WorkspaceWithRuns[]
    dependencyGraph: DependencyGraph | null
    selectedPath: string
    onSelect: (path: string) => void
  }

  let props: Props = $props()

  const workspaces = $derived(props.workspaces)
  const dependencyGraph = $derived(props.dependencyGraph)
  const selectedPath = $derived(props.selectedPath)
  const onSelect = $derived(props.onSelect)

  // Build workspace lookup by path
  const workspaceByPath = $derived(
    new Map(workspaces.map((ws) => [ws.preview.workspacePath, ws]))
  )

  /**
   * Compute the depth (column) for each workspace.
   * Depth 0 = no dependencies (roots), higher = further from roots.
   */
  function computeDepths(graph: DependencyGraph): Map<string, number> {
    const depths = new Map<string, number>()
    const deps = new Map<string, Set<string>>()

    // Build dependency lookup (source depends on target)
    for (const [source, target] of graph.edges) {
      if (!deps.has(source)) deps.set(source, new Set())
      deps.get(source)!.add(target)
    }

    // Initialize all workspaces at depth 0
    for (const ws of graph.workspaces) {
      depths.set(ws, 0)
    }

    // Iteratively compute depths (depth = max(dep depths) + 1)
    let changed = true
    while (changed) {
      changed = false
      for (const ws of graph.workspaces) {
        const wsDeps = deps.get(ws)
        if (!wsDeps || wsDeps.size === 0) continue

        let maxDepth = 0
        for (const dep of wsDeps) {
          const depDepth = depths.get(dep) ?? 0
          maxDepth = Math.max(maxDepth, depDepth)
        }

        const newDepth = maxDepth + 1
        if (newDepth !== depths.get(ws)) {
          depths.set(ws, newDepth)
          changed = true
        }
      }
    }

    return depths
  }

  /**
   * Group workspaces by their depth into columns.
   */
  function groupByDepth(
    wsSet: WorkspaceWithRuns[],
    depths: Map<string, number>
  ): WorkspaceWithRuns[][] {
    const maxDepth = Math.max(...Array.from(depths.values()), 0)
    const columns: WorkspaceWithRuns[][] = Array.from(
      { length: maxDepth + 1 },
      () => []
    )

    for (const ws of wsSet) {
      const depth = depths.get(ws.preview.workspacePath) ?? 0
      columns[depth].push(ws)
    }

    // Sort each column by path for consistent ordering
    for (const col of columns) {
      col.sort((a, b) => 
        a.preview.workspacePath.localeCompare(b.preview.workspacePath)
      )
    }

    return columns
  }

  // Compute columns layout
  const columns = $derived.by(() => {
    if (!dependencyGraph || dependencyGraph.edges.length === 0) {
      // No dependencies - single column with all workspaces
      return [workspaces]
    }

    const depths = computeDepths(dependencyGraph)
    return groupByDepth(workspaces, depths)
  })

  // Maximum rows across all columns (for row alignment)
  const maxRows = $derived(Math.max(...columns.map((col) => col.length), 1))

  // Get edges between adjacent columns for drawing
  interface Edge {
    sourceCol: number
    sourceRow: number
    targetCol: number
    targetRow: number
  }

  const edges = $derived.by((): Edge[] => {
    if (!dependencyGraph || dependencyGraph.edges.length === 0) return []

    const result: Edge[] = []
    const nodePosition = new Map<string, { col: number; row: number }>()

    // Build position map
    columns.forEach((col, colIdx) => {
      col.forEach((ws, rowIdx) => {
        nodePosition.set(ws.preview.workspacePath, { col: colIdx, row: rowIdx })
      })
    })

    // Create edges (source depends on target, so arrow goes target -> source)
    for (const [source, target] of dependencyGraph.edges) {
      const sourcePos = nodePosition.get(source)
      const targetPos = nodePosition.get(target)
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

  // Get run status for a workspace
  function getRunStatus(
    workspace: WorkspaceWithRuns,
    runType: "plan" | "apply"
  ): string | null {
    const run = workspace.runs.find((r: Run) => r.runType === runType)
    return run?.status ?? null
  }

  // Status icons
  function statusIcon(status: string | null): string {
    if (!status) return "~"
    switch (status) {
      case "success": return "✓"
      case "running": return "..."
      case "pending": return "~"
      case "failed": return "✗"
      case "cancelled": return "✗"
      case "skipped": return "-"
      default: return "~"
    }
  }

  function statusColor(status: string | null): string {
    if (!status) return "text-text-dim"
    switch (status) {
      case "success": return "text-status-ready"
      case "running": return "text-status-applying"
      case "pending": return "text-status-pending"
      case "failed": return "text-status-failed"
      case "cancelled": return "text-text-dim"
      case "skipped": return "text-text-muted"
      default: return "text-text-muted"
    }
  }

  // Check if a workspace has any failed upstream dependencies
  function hasFailedUpstream(wsPath: string): boolean {
    if (!dependencyGraph) return false

    const deps = dependencyGraph.edges
      .filter((edge: [string, string]) => edge[0] === wsPath)
      .map((edge: [string, string]) => edge[1])

    for (const depPath of deps) {
      const depWs = workspaceByPath.get(depPath)
      if (!depWs) continue

      const planStatus = getRunStatus(depWs, "plan")
      const applyStatus = getRunStatus(depWs, "apply")

      if (planStatus === "failed" || applyStatus === "failed") {
        return true
      }
    }

    return false
  }

  // SVG dimensions and layout constants
  const nodeHeight = 52
  const nodeGapX = 80
  const nodeGapY = 12
  const nodePadX = 12

  // Measure text width (approximate using character count)
  function estimateTextWidth(text: string): number {
    // Monospace: ~7px per character at 11px font size
    return text.length * 7 + nodePadX * 2
  }

  // Compute column widths (widest node in each column)
  const columnWidths = $derived(
    columns.map((col) => {
      const widths = col.map((ws) => estimateTextWidth(ws.preview.workspacePath))
      return Math.max(...widths, 100) // minimum 100px
    })
  )

  // Compute column X positions
  const columnX = $derived(() => {
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
    columnWidths.reduce((sum, w) => sum + w, 0) + 
    nodeGapX * (columnWidths.length + 1)
  )
  const svgHeight = $derived(
    maxRows * (nodeHeight + nodeGapY) + nodeGapY
  )

  // Get node position
  function getNodeX(colIdx: number): number {
    return columnX()[colIdx]
  }

  function getNodeY(rowIdx: number): number {
    return rowIdx * (nodeHeight + nodeGapY) + nodeGapY
  }

  // Generate edge path (bezier curve)
  function edgePath(edge: Edge): string {
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
  {#if columns.length === 0 || workspaces.length === 0}
    <div class="text-text-dim text-xs text-center py-4">No workspaces</div>
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
          id="endpoint"
          markerWidth="4"
          markerHeight="6"
          refX="4"
          refY="3"
          orient="auto"
        >
          <path
            d="M 4 0 A 3 3 0 0 0 4 6"
            fill="var(--color-border)"
          />
        </marker>
      </defs>

      <!-- Edges (drawn first so they're behind nodes) -->
      <g class="edges">
        {#each edges as edge}
          <path
            d={edgePath(edge)}
            fill="none"
            stroke="var(--color-border)"
            stroke-width="2"
            marker-end="url(#endpoint)"
          />
        {/each}
      </g>

      <!-- Nodes by column -->
      <g class="nodes">
        {#each columns as column, colIdx}
          {#each column as workspace, rowIdx}
            {@const isSelected = workspace.preview.workspacePath === selectedPath}
            {@const planStatus = getRunStatus(workspace, "plan")}
            {@const applyStatus = getRunStatus(workspace, "apply")}
            {@const isBlocked = hasFailedUpstream(workspace.preview.workspacePath)}
            {@const x = getNodeX(colIdx)}
            {@const y = getNodeY(rowIdx)}
            {@const width = columnWidths[colIdx]}

            <g
              transform="translate({x}, {y})"
              class="node-group cursor-pointer"
              role="button"
              tabindex="0"
              onclick={() => onSelect(workspace.preview.workspacePath)}
              onkeydown={(e) => e.key === "Enter" && onSelect(workspace.preview.workspacePath)}
            >
              <!-- Node background -->
              <rect
                {width}
                height={nodeHeight}
                rx="6"
                class="node-bg transition-all"
                class:selected={isSelected}
                class:blocked={isBlocked}
              />

              <!-- Node label (full path) -->
              <text
                x={nodePadX}
                y="20"
                class="node-label"
              >
                <title>{workspace.preview.workspacePath}</title>
                {workspace.preview.workspacePath}
              </text>

              <!-- Status indicators -->
              <text x={nodePadX} y="40" class="node-status">
                <tspan class={statusColor(planStatus)}>P:{statusIcon(planStatus)}</tspan>
                <tspan dx="8" class={statusColor(applyStatus)}>A:{statusIcon(applyStatus)}</tspan>
              </text>
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
    padding: 0.5rem;
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

  .node-bg {
    fill: var(--color-surface-overlay);
    stroke: var(--color-border);
    stroke-width: 1;
  }

  .node-bg:hover {
    stroke: var(--color-yaffle-500);
    stroke-opacity: 0.5;
  }

  .node-bg.selected {
    fill: color-mix(in srgb, var(--color-yaffle-500) 20%, transparent);
    stroke: var(--color-yaffle-500);
  }

  .node-bg.blocked {
    fill: color-mix(in srgb, var(--color-surface-overlay) 50%, transparent);
    stroke-opacity: 0.5;
    opacity: 0.6;
  }

  .node-label {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    fill: var(--color-text);
  }

  .node-status {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    fill: var(--color-text-muted);
  }

  .node-group:focus {
    outline: none;
  }

  .node-group:focus .node-bg {
    stroke: var(--color-yaffle-500);
    stroke-width: 2;
  }

  /* Status colors applied via class */
  :global(.text-status-ready) {
    fill: var(--color-status-ready);
  }
  :global(.text-status-applying) {
    fill: var(--color-status-applying);
  }
  :global(.text-status-pending) {
    fill: var(--color-status-pending);
  }
  :global(.text-status-failed) {
    fill: var(--color-status-failed);
  }
  :global(.text-text-dim) {
    fill: var(--color-text-dim);
  }
  :global(.text-text-muted) {
    fill: var(--color-text-muted);
  }
</style>
