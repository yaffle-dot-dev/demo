<script lang="ts">
  import type { WorkspaceWithRuns, DependencyGraph, Run } from "$lib/api"
  import { triggerApply } from "$lib/api"

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

  // ============================================================================
  // Countdown timer state for auto-apply
  // ============================================================================
  
  interface TimerState {
    workspacePath: string
    remaining: number // seconds remaining
    paused: boolean
    total: number // total seconds
  }
  
  let timers = $state<Map<string, TimerState>>(new Map())
  
  // Timer interval management - 50ms for smooth animation
  const TICK_MS = 50
  const TICK_SEC = TICK_MS / 1000
  let timerInterval: ReturnType<typeof setInterval> | null = null
  
  function startTimer(workspacePath: string, seconds: number = 10) {
    timers.set(workspacePath, {
      workspacePath,
      remaining: seconds,
      paused: false,
      total: seconds,
    })
    timers = new Map(timers) // trigger reactivity
    ensureTimerInterval()
  }
  
  function ensureTimerInterval() {
    if (timerInterval) return
    
    timerInterval = setInterval(() => {
      let anyActive = false
      for (const [path, timer] of timers) {
        if (!timer.paused && timer.remaining > 0) {
          timer.remaining -= TICK_SEC
          anyActive = true
          if (timer.remaining <= 0) {
            timer.remaining = 0
            // Timer completed - trigger apply
            timers.delete(path)
            handleApply(path)
          }
        } else if (timer.remaining > 0) {
          anyActive = true
        }
      }
      timers = new Map(timers) // trigger reactivity
      
      if (!anyActive && timerInterval) {
        clearInterval(timerInterval)
        timerInterval = null
      }
    }, TICK_MS)
  }
  
  // Track apply states for UI feedback
  let applyingWorkspaces = $state<Set<string>>(new Set())
  let applyErrors = $state<Map<string, string>>(new Map())
  
  // Retry configuration
  const MAX_RETRIES = 3
  const RETRY_DELAY_MS = 1000
  
  /**
   * Trigger apply for a workspace with retry logic.
   * Called by timer completion or Approve button.
   * Retries up to MAX_RETRIES times on failure to ensure apply is triggered.
   */
  async function handleApply(workspacePath: string, attempt: number = 1) {
    const ws = workspaceByPath.get(workspacePath)
    if (!ws) {
      console.error(`Workspace not found: ${workspacePath}`)
      return
    }
    
    const previewId = ws.preview.id
    applyingWorkspaces.add(workspacePath)
    applyingWorkspaces = new Set(applyingWorkspaces)
    applyErrors.delete(workspacePath)
    applyErrors = new Map(applyErrors)
    
    try {
      const result = await triggerApply(previewId)
      console.log(`Apply started for ${workspacePath}:`, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Apply failed"
      
      // Don't retry for expected errors (already in progress, already completed)
      const noRetryErrors = ["apply already in progress", "apply already completed"]
      if (noRetryErrors.some(e => message.includes(e))) {
        console.log(`Apply for ${workspacePath}: ${message}`)
        applyingWorkspaces.delete(workspacePath)
        applyingWorkspaces = new Set(applyingWorkspaces)
        return
      }
      
      // Retry on transient failures
      if (attempt < MAX_RETRIES) {
        console.warn(`Apply failed for ${workspacePath} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms:`, message)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt))
        return handleApply(workspacePath, attempt + 1)
      }
      
      // Max retries exceeded
      console.error(`Apply failed for ${workspacePath} after ${MAX_RETRIES} attempts:`, message)
      applyErrors.set(workspacePath, message)
      applyErrors = new Map(applyErrors)
    } finally {
      applyingWorkspaces.delete(workspacePath)
      applyingWorkspaces = new Set(applyingWorkspaces)
    }
  }
  
  function togglePause(workspacePath: string) {
    const timer = timers.get(workspacePath)
    if (timer) {
      timer.paused = !timer.paused
      timers = new Map(timers)
    }
  }
  
  // Reactive timer accessors - these read from the reactive `timers` map
  function getTimerProgress(wsPath: string): number {
    const t = timers.get(wsPath)
    if (!t) return 0
    return t.remaining / t.total
  }
  
  function getTimerSecondsLeft(wsPath: string): number {
    const t = timers.get(wsPath)
    if (!t) return 0
    return Math.ceil(t.remaining)
  }
  
  function isTimerPaused(wsPath: string): boolean {
    const t = timers.get(wsPath)
    return t?.paused ?? false
  }
  
  // Cleanup interval on component destroy
  $effect(() => {
    return () => {
      if (timerInterval) {
        clearInterval(timerInterval)
        timerInterval = null
      }
    }
  })
  
  // Track which workspaces have had their timers auto-started (to avoid re-triggering)
  let autoStartedTimers = $state<Set<string>>(new Set())
  
  // Parse plan summary string like "+3, ~1, -0" into structured data
  function parsePlanSummary(summary: string | null): { add: number; change: number; destroy: number } | null {
    if (!summary || summary === "no changes" || summary === "unknown") return null
    
    const match = summary.match(/\+(\d+),\s*~(\d+),\s*-(\d+)/)
    if (!match) return null
    
    return {
      add: parseInt(match[1], 10),
      change: parseInt(match[2], 10),
      destroy: parseInt(match[3], 10),
    }
  }
  
  function hasChanges(summary: { add: number; change: number; destroy: number } | null): boolean {
    if (!summary) return false
    return summary.add > 0 || summary.change > 0 || summary.destroy > 0
  }
  
  function getRequiresApproval(workspace: WorkspaceWithRuns): boolean {
    return workspace.preview.requireApproval
  }

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
  
  // Get plan summary for a workspace
  function getPlanSummary(workspace: WorkspaceWithRuns): { add: number; change: number; destroy: number } | null {
    const planRun = workspace.runs.find((r: Run) => r.runType === "plan")
    if (!planRun?.planSummary) return null
    return parsePlanSummary(planRun.planSummary)
  }
  
  // Get run status for plan or apply
  function getEffectiveStatus(workspace: WorkspaceWithRuns, runType: "plan" | "apply"): string | null {
    return getRunStatus(workspace, runType)
  }
  
  // Check if workspace is ready for apply (plan succeeded with changes, apply not started)
  function isReadyForApply(workspace: WorkspaceWithRuns): boolean {
    const planStatus = getEffectiveStatus(workspace, "plan")
    const applyStatus = getEffectiveStatus(workspace, "apply")
    const summary = getPlanSummary(workspace)
    
    return planStatus === "success" && 
           hasChanges(summary) && 
           applyStatus === null
  }
  
  // Check if workspace should auto-start timer (ready for apply, no approval required)
  function shouldAutoStartTimer(workspace: WorkspaceWithRuns): boolean {
    const wsPath = workspace.preview.workspacePath
    return isReadyForApply(workspace) && 
           !getRequiresApproval(workspace) &&
           !timers.has(wsPath) &&
           !autoStartedTimers.has(wsPath)
  }
  
  // Auto-apply countdown duration in seconds
  const AUTO_APPLY_DELAY_SEC = 10
  
  // Auto-start timers for workspaces that are ready for apply
  $effect(() => {
    for (const ws of workspaces) {
      const wsPath = ws.preview.workspacePath
      
      // Check if this workspace should have an auto-started timer
      if (shouldAutoStartTimer(ws) && !autoStartedTimers.has(wsPath)) {
        autoStartedTimers.add(wsPath)
        autoStartedTimers = new Set(autoStartedTimers)
        startTimer(wsPath, AUTO_APPLY_DELAY_SEC)
      }
    }
  })

  // Status icons
  function statusIcon(status: string | null): string {
    if (!status) return "~"
    switch (status) {
      case "success": return "✓"
      case "running": return "⟳"
      case "pending": return "○"
      case "waiting": return "◐"
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
      case "waiting": return "text-status-waiting"
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
  const nodeHeight = 78 // Fits label + button + status + padding
  const nodeGapX = 80
  const nodeGapY = 16
  const nodePadX = 6

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
            {@const wsPath = workspace.preview.workspacePath}
            {@const isSelected = wsPath === selectedPath}
            {@const planStatus = getEffectiveStatus(workspace, "plan")}
            {@const applyStatus = getEffectiveStatus(workspace, "apply")}
            {@const planSummary = getPlanSummary(workspace)}
            {@const isBlocked = hasFailedUpstream(wsPath)}
            {@const readyForApply = isReadyForApply(workspace)}
            {@const requiresApproval = getRequiresApproval(workspace)}
            {@const x = getNodeX(colIdx)}
            {@const y = getNodeY(rowIdx)}
            {@const width = columnWidths[colIdx]}
            {@const btnWidth = 72}
            {@const btnHeight = 18}
            {@const btnRadius = 4}
            {@const ringRadius = 6}
            {@const circumference = 2 * Math.PI * ringRadius}

            <g
              transform="translate({x}, {y})"
              class="node-group cursor-pointer"
              role="button"
              tabindex="0"
              onclick={() => onSelect(wsPath)}
              onkeydown={(e) => e.key === "Enter" && onSelect(wsPath)}
            >
              <!-- Node background -->
              <rect
                {width}
                height={nodeHeight}
                rx="6"
                class="node-bg transition-all"
                class:selected={isSelected}
                class:blocked={isBlocked}
                class:has-changes={hasChanges(planSummary)}
                class:waiting={readyForApply && !requiresApproval}
              />

              <!-- Node label (full path) -->
              <text
                x={nodePadX}
                y="18"
                class="node-label"
              >
                <title>{wsPath}</title>
                {wsPath}
              </text>

              <!-- Bottom area: action button (row 1), status below (row 2) -->
              <g transform="translate({nodePadX}, 44)">
                <!-- Row 1: Action buttons (y=0, only when applicable) -->
                {#if timers.has(wsPath)}
                  {#if isTimerPaused(wsPath)}
                    <g 
                      class="approval-btn"
                      role="button"
                      tabindex="0"
                      onclick={(e) => { e.stopPropagation(); handleApply(wsPath) }}
                      onkeydown={(e) => e.key === "Enter" && handleApply(wsPath)}
                    >
                      <title>Click to approve and start apply</title>
                      <rect x="0" y="0" width={btnWidth} height={btnHeight} rx={btnRadius} class="approval-btn-bg" />
                      <text x={btnWidth / 2} y="13" text-anchor="middle" class="approval-btn-text">Approve</text>
                    </g>
                  {:else}
                    <g 
                      class="timer-btn"
                      role="button"
                      tabindex="0"
                      onclick={(e) => { e.stopPropagation(); togglePause(wsPath) }}
                      onkeydown={(e) => e.key === "Enter" && togglePause(wsPath)}
                    >
                      <title>{getTimerSecondsLeft(wsPath)}s until apply starts. Click to pause.</title>
                      <rect x="0" y="0" width={btnWidth} height={btnHeight} rx={btnRadius} class="timer-btn-bg" />
                      <g transform="translate(10, 9)">
                        <circle cx="0" cy="0" r={ringRadius} fill="none" stroke="var(--color-border)" stroke-width="1.5" />
                        <circle 
                          cx="0" cy="0" r={ringRadius}
                          fill="none" 
                          stroke="var(--color-yaffle-500)"
                          stroke-width="1.5"
                          stroke-dasharray={circumference}
                          stroke-dashoffset={-circumference * (1 - getTimerProgress(wsPath))}
                          stroke-linecap="round"
                          transform="rotate(-90)"
                          class="timer-progress"
                        />
                      </g>
                      <text x="44" y="13" text-anchor="middle" class="timer-btn-text">Pause</text>
                    </g>
                  {/if}
                {:else if readyForApply && requiresApproval}
                  <g 
                    class="approval-btn"
                    role="button"
                    tabindex="0"
                    onclick={(e) => { e.stopPropagation(); handleApply(wsPath) }}
                    onkeydown={(e) => e.key === "Enter" && handleApply(wsPath)}
                  >
                    <title>Click to approve and start apply</title>
                    <rect x="0" y="0" width={btnWidth} height={btnHeight} rx={btnRadius} class="approval-btn-bg" />
                    <text x={btnWidth / 2} y="13" text-anchor="middle" class="approval-btn-text">Approve</text>
                  </g>
                {/if}
                
                <!-- Row 2: Status (y=28, below button which ends at y=18) -->
                <!-- Priority: apply status > plan status (apply is more recent/relevant) -->
                {#if applyStatus === "running"}
                  <text y="28" class="node-status text-status-applying">{statusIcon("running")} Applying...</text>
                {:else if applyStatus === "success"}
                  <text y="28" class="node-status text-status-ready">{statusIcon("success")} Applied</text>
                {:else if applyStatus === "failed"}
                  <text y="28" class="node-status text-status-error">{statusIcon("failed")} Apply failed</text>
                {:else if applyStatus === "skipped"}
                  <text y="28" class="node-status text-status-ready">{statusIcon("success")} No changes</text>
                {:else if planStatus === "running"}
                  <text y="28" class="node-status text-status-applying">{statusIcon("running")} Planning...</text>
                {:else if planStatus === "failed"}
                  <text y="28" class="node-status text-status-failed">{statusIcon("failed")} Plan failed</text>
                {:else if planStatus === "skipped"}
                  <text y="28" class="node-status text-text-dim">{statusIcon("skipped")} Skipped</text>
                {:else if planStatus === "pending"}
                  <text y="28" class="node-status text-text-dim">{statusIcon("waiting")} Waiting...</text>
                {:else if planStatus === "success" && planSummary && hasChanges(planSummary)}
                  <text y="28" class="node-plan-summary">
                    <tspan class="plan-add">+{planSummary.add}</tspan>
                    <tspan dx="4" class="plan-change">~{planSummary.change}</tspan>
                    <tspan dx="4" class="plan-destroy">-{planSummary.destroy}</tspan>
                  </text>
                {:else if planStatus === "success"}
                  <text y="28" class="node-status text-status-ready">{statusIcon("success")} No changes</text>
                {:else}
                  <text y="28" class="node-status text-text-dim">—</text>
                {/if}
              </g>
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
  
  .node-bg.has-changes {
    stroke: var(--color-status-pending);
    stroke-width: 1.5;
  }
  
  .node-bg.waiting {
    stroke: var(--color-yaffle-500);
    stroke-width: 2;
    stroke-dasharray: 4 2;
    animation: dash-march 0.5s linear infinite;
  }
  
  @keyframes dash-march {
    to {
      stroke-dashoffset: -6;
    }
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
  
  .node-plan-summary {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    font-weight: 600;
  }
  
  .plan-add {
    fill: var(--color-status-ready);
  }
  
  .plan-change {
    fill: var(--color-status-pending);
  }
  
  .plan-destroy {
    fill: var(--color-status-failed);
  }

  .node-group:focus {
    outline: none;
  }

  .node-group:focus .node-bg {
    stroke: var(--color-yaffle-500);
    stroke-width: 2;
  }
  
  /* Timer button (matches approval button style) */
  .timer-btn {
    cursor: pointer;
  }
  
  .timer-btn-bg {
    fill: var(--color-yaffle-500);
    fill-opacity: 0.15;
    stroke: var(--color-yaffle-500);
    stroke-width: 1;
    transition: fill-opacity 0.15s ease;
  }
  
  .timer-btn:hover .timer-btn-bg {
    fill-opacity: 0.3;
  }
  
  .timer-btn-text {
    font-family: var(--font-mono, monospace);
    font-size: 9px;
    fill: var(--color-yaffle-500);
  }
  
  .timer-progress {
    /* No transition - we want smooth updates from the interval */
  }
  
  /* Approval button for requireApproval workspaces */
  .approval-btn {
    cursor: pointer;
  }
  
  .approval-btn-bg {
    fill: var(--color-status-pending);
    fill-opacity: 0.15;
    stroke: var(--color-status-pending);
    stroke-width: 1;
    transition: fill-opacity 0.15s ease;
  }
  
  .approval-btn:hover .approval-btn-bg {
    fill-opacity: 0.3;
  }
  
  .approval-btn-text {
    font-family: var(--font-mono, monospace);
    font-size: 9px;
    fill: var(--color-status-pending);
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
  :global(.text-status-waiting) {
    fill: var(--color-yaffle-500);
  }
  :global(.text-status-failed) {
    fill: var(--color-status-failed);
  }
  :global(.text-status-error) {
    fill: var(--color-accent-500);
  }
  :global(.text-text-dim) {
    fill: var(--color-text-dim);
  }
  :global(.text-text-muted) {
    fill: var(--color-text-muted);
  }
</style>
