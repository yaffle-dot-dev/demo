<script lang="ts">
  import type { DependencyGraph, Run, WorkspaceWithRuns } from "$lib/api"
  import { triggerApply, pauseApply } from "$lib/api"
  import { statusConfig } from "$lib/status"
  import {
    getBlockingUpstreamWorkspacePaths,
    getWorkspaceConnectionBlockReason,
  } from "$lib/workspace-status"
  import type { PreviewDagNode, PreviewLifecycleDagNode, PreviewWorkspaceDagNode } from "$lib/lifecycle-dag"
  import DagLayout from "./DagLayout.svelte"
  import type { DagPosition } from "./DagLayout.svelte"

  interface Props {
    nodes: PreviewDagNode[]
    dependencyGraph: DependencyGraph | null
    nodeStatuses: Record<string, string>
    selectedPath: string
    onSelect: (path: string) => void
    compact?: boolean
  }

  let props: Props = $props()



  const dagNodes = $derived(props.nodes)
  const dependencyGraph = $derived(props.dependencyGraph)
  const nodeStatuses = $derived(props.nodeStatuses)
  const selectedPath = $derived(props.selectedPath)
  const onSelect = $derived(props.onSelect)
  const compact = $derived(props.compact ?? false)

  const workspaceNodes = $derived(
    dagNodes.filter((node): node is PreviewWorkspaceDagNode => node.kind === "workspace"),
  )
  const workspaces = $derived(
    workspaceNodes
      .map((node) => node.workspace)
      .filter((workspace): workspace is WorkspaceWithRuns => workspace !== null),
  )

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
            // Timer completed - just remove it. Server handles auto-apply.
            timers.delete(path)
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
    
    // Clear any active timer for this workspace (user clicked Approve)
    if (timers.has(workspacePath)) {
      timers.delete(workspacePath)
      timers = new Map(timers)
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
  
  // Track which workspaces are being paused (for loading state)
  let pausingWorkspaces = $state<Set<string>>(new Set())
  
  /**
   * Pause auto-apply for a workspace.
   * Calls the server /pause endpoint to transition to awaiting_approval state.
   * On success, marks the local timer as paused so UI shows "Approve" button.
   */
  async function handlePause(workspacePath: string) {
    const ws = workspaceByPath.get(workspacePath)
    if (!ws) {
      console.error(`Workspace not found: ${workspacePath}`)
      return
    }
    
    const previewId = ws.preview.id
    pausingWorkspaces.add(workspacePath)
    pausingWorkspaces = new Set(pausingWorkspaces)
    
    try {
      const result = await pauseApply(previewId)
      console.log(`Pause result for ${workspacePath}:`, result)
      
      // Mark local timer as paused
      const timer = timers.get(workspacePath)
      if (timer) {
        timer.paused = true
        timers = new Map(timers)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Pause failed"
      console.error(`Pause failed for ${workspacePath}:`, message)
      
      // If the error indicates the deployment is already applying or applied,
      // just remove the timer - the UI will update from SSE
      if (message.includes("already") || message.includes("too late")) {
        timers.delete(workspacePath)
        timers = new Map(timers)
      }
    } finally {
      pausingWorkspaces.delete(workspacePath)
      pausingWorkspaces = new Set(pausingWorkspaces)
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

  // Derive a list of workspace paths that are ready for auto-apply timer.
  // This derived value ensures the $effect below re-runs when workspace status changes.
  const workspacesReadyForAutoTimer = $derived.by((): string[] => {
    const ready: string[] = []
    for (const workspace of workspaces) {
      const wsPath = workspace.preview.workspacePath
      const planStatus = getEffectiveStatus(workspace, "plan")
      const applyStatus = getEffectiveStatus(workspace, "apply")
      const summary = getPlanSummary(workspace)
      const requiresApproval = workspace.preview.requireApproval
      
      // Ready for auto-timer: plan succeeded with changes, no apply yet, no approval required
      if (
        planStatus === "success" &&
        hasChanges(summary) &&
        applyStatus === null &&
        !requiresApproval
      ) {
        ready.push(wsPath)
      }
    }
    return ready
  })
  
  // Parse plan summary string like "+3, ~1, -0" into structured data
  function parsePlanSummary(summary: string | null): { add: number; change: number; destroy: number } | null {
    if (!summary || summary === "no changes" || summary === "unknown") return null

    const canonical = summary.match(/\+(\d+),\s*~(\d+),\s*-(\d+)/)
    if (canonical) {
      return {
        add: parseInt(canonical[1], 10),
        change: parseInt(canonical[2], 10),
        destroy: parseInt(canonical[3], 10),
      }
    }

    const sparseMatches = [...summary.matchAll(/([+~-])(\d+)/g)]
    if (sparseMatches.length === 0) return null

    let add = 0
    let change = 0
    let destroy = 0

    for (const [, prefix, value] of sparseMatches) {
      const count = parseInt(value, 10)
      if (prefix === "+") add = count
      if (prefix === "~") change = count
      if (prefix === "-") destroy = count
    }

    return {
      add,
      change,
      destroy,
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
    new Map(workspaces.map((workspace) => [workspace.preview.workspacePath, workspace]))
  )

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
  
  // Visual countdown duration in seconds (user has this much time to pause)
  // Server auto-applies after 30s, so this gives a 10s buffer
  const AUTO_APPLY_DELAY_SEC = 20
  
  // Auto-start timers for workspaces that are ready for apply.
  // Uses the derived workspacesReadyForAutoTimer to ensure proper reactivity tracking.
  $effect(() => {
    for (const wsPath of workspacesReadyForAutoTimer) {
      // Only start timer if not already started or active
      if (!timers.has(wsPath) && !autoStartedTimers.has(wsPath)) {
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
      case "degraded": return "◐"
      case "blocked": return "⚠"
      case "failed": return "✗"
      case "system_error": return "⚠"
      case "cancelled": return "✗"
      case "skipped": return "-"
      default: return "~"
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

  function getConnectionBlockedLabel(workspace: WorkspaceWithRuns): string | null {
    const reason = getWorkspaceConnectionBlockReason(workspace)
    if (!reason) return null

    if (workspace.preview.connectionStatus === "missing") {
      return workspace.preview.missingProviders.length === 1
        ? `Missing ${workspace.preview.missingProviders[0]}`
        : "Missing connections"
    }

    if (workspace.preview.connectionStatus === "conflict") {
      return workspace.preview.conflictProviders.length === 1
        ? `Conflicting ${workspace.preview.conflictProviders[0]}`
        : "Conflicting connections"
    }

    if (workspace.preview.degradation) {
      return "Metadata degraded"
    }

    return "Blocked"
  }

  function getUpstreamBlockedLabel(wsPath: string): string | null {
    const upstreamPaths = getBlockingUpstreamWorkspacePaths(wsPath, workspaces, dependencyGraph)
    if (upstreamPaths.length === 0) {
      return null
    }

    return "Waiting on upstream"
  }

  // Layout constants for cells
  const NODE_HEIGHT = $derived(compact ? 24 : 92)
  const NODE_PAD_X = $derived(compact ? 4 : 8)
  const NODE_GAP_X = $derived(compact ? 14 : 40)
  const NODE_GAP_Y = $derived(compact ? 6 : 16)
  const MIN_COLUMN_WIDTH = $derived(compact ? 64 : 100)
  const COMPACT_LABEL_RESERVED_WIDTH = $derived(compact ? 18 : 0)

  // Estimate text width (approximate using character count)
  function estimateTextWidth(node: PreviewDagNode): number {
    const label = node.kind === "workspace"
      ? node.workspacePath
      : `${lifecyclePhaseIcon(node.phase)} ${humanizeLifecycleKey(node.key)}`
    const glyphWidth = compact ? 6 : 7
    const minWidth = compact
      ? node.kind === "lifecycle" ? 76 : 64
      : node.kind === "lifecycle" ? 184 : 148

    return Math.max(
      label.length * glyphWidth + NODE_PAD_X * 2 + COMPACT_LABEL_RESERVED_WIDTH,
      minWidth,
    )
  }

  function compactLabelLimit(width: number): number {
    const availableWidth = width - NODE_PAD_X * 2 - COMPACT_LABEL_RESERVED_WIDTH
    return Math.max(4, Math.floor(availableWidth / 6))
  }

  // Get unique ID for DAG layout
  function getId(node: PreviewDagNode): string {
    return node.id
  }

  function lifecyclePhaseIcon(phase: string): string {
    return phase === "verification" ? "VERIFY" : "READY"
  }

  function humanizeLifecycleKey(key: string): string {
    return key
      .replace(/^preview[-_]/, "")
      .replace(/^activation[-_]/, "")
      .replace(/^verification[-_]/, "")
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ") || key
  }

  function lifecycleNodeScopeText(node: PreviewLifecycleDagNode): string {
    if (node.item.scopes.length === 0) {
      return node.phase === "verification"
        ? "confirms the preview externally"
        : "waits for the preview to come alive"
    }

    if (node.phase === "verification") {
      return `proves ${node.item.scopes.join(" + ")}`
    }

    return `unlocks ${node.item.scopes.join(" + ")}`
  }

  function truncateCopy(value: string, maxLength: number): string {
    return value.length <= maxLength
      ? value
      : `${value.slice(0, Math.max(0, maxLength - 1))}…`
  }

  function lifecycleStatusClass(state: string): string {
    switch (state) {
      case "succeeded": return "text-status-ready"
      case "degraded": return "text-status-pending"
      case "blocked": return "text-status-error"
      case "failed": return "text-status-failed"
      case "running": return "text-status-applying"
      default: return "text-text-dim"
    }
  }

  function lifecycleStatusText(node: PreviewLifecycleDagNode): string {
    switch (node.item.state) {
      case "succeeded":
        return node.phase === "verification" ? "checks passed" : "preview is live"
      case "degraded": return "ready with warnings"
      case "blocked": return "policy blocked"
      case "failed":
        return node.phase === "verification" ? "checks failed" : "readiness failed"
      case "running":
        return node.phase === "verification" ? "checking preview" : "waiting for signal"
      default:
        return node.phase === "verification" ? "queued to verify" : "queued to open"
    }
  }

  function compactWorkspaceGlyph(
    planStatus: string | null,
    applyStatus: string | null,
    planSummary: { add: number; change: number; destroy: number } | null,
    connectionBlockedLabel: string | null,
    upstreamBlockedLabel: string | null,
    isBlocked: boolean,
    displayStatus: string,
  ): { icon: string; className: string; title: string } {
    if (applyStatus === "running") return { icon: "...", className: "text-status-applying", title: "Applying" }
    if (applyStatus === "success") return { icon: "✓", className: "text-status-ready", title: "Applied" }
    if (applyStatus === "failed") return { icon: "✗", className: "text-status-error", title: "Apply failed" }
    if (applyStatus === "cancelled") return { icon: "✗", className: "text-status-failed", title: "Apply cancelled" }
    if (applyStatus === "skipped") return { icon: "-", className: "text-status-ready", title: "No changes" }
    if (planStatus === "running") return { icon: "...", className: "text-status-applying", title: "Planning" }
    if (planStatus === "failed") return { icon: "✗", className: "text-status-failed", title: "Plan failed" }
    if (planStatus === "cancelled") return { icon: "✗", className: "text-status-failed", title: "Plan cancelled" }
    if (planStatus === "skipped") return { icon: "-", className: "text-text-dim", title: "Skipped" }
    if (planStatus === "pending") return { icon: "~", className: "text-text-dim", title: "Waiting" }
    if (planStatus === "success" && planSummary && hasChanges(planSummary)) {
      return {
        icon: "~",
        className: "text-status-planning",
        title: `+${planSummary.add} ~${planSummary.change} -${planSummary.destroy}`,
      }
    }
    if (planStatus === "success") return { icon: "✓", className: "text-status-ready", title: "No changes" }
    if (connectionBlockedLabel) return { icon: "⚠", className: "text-status-error", title: connectionBlockedLabel }
    if (upstreamBlockedLabel) return { icon: "~", className: "text-text-dim", title: upstreamBlockedLabel }
    if (isBlocked) {
      const skippedCfg = statusConfig("skipped")
      return { icon: skippedCfg.icon, className: skippedCfg.color, title: skippedCfg.label }
    }

    const fallbackCfg = statusConfig(displayStatus)
    return { icon: fallbackCfg.icon, className: fallbackCfg.color, title: fallbackCfg.label }
  }

  function compactLifecycleGlyph(state: string): { icon: string; className: string } {
    return {
      icon: statusIcon(
        state === "running"
          ? "running"
          : state === "succeeded"
            ? "success"
            : state,
      ),
      className: lifecycleStatusClass(state),
    }
  }
</script>

{#snippet node({ item, position, width, height }: { item: PreviewDagNode; position: DagPosition; width: number; height: number })}
  {@const isSelected = item.id === selectedPath}
  <g
    class="node-group cursor-pointer"
    role="button"
    tabindex="0"
    onclick={() => onSelect(item.id)}
    onkeydown={(e) => e.key === "Enter" && onSelect(item.id)}
  >
    {#if item.kind === "workspace" && item.workspace}
      {@const workspace = item.workspace}
      {@const wsPath = workspace.preview.workspacePath}
      {@const planStatus = getEffectiveStatus(workspace, "plan")}
      {@const applyStatus = getEffectiveStatus(workspace, "apply")}
      {@const displayStatus = nodeStatuses[wsPath] ?? workspace.preview.status}
      {@const planSummary = getPlanSummary(workspace)}
      {@const isBlocked = hasFailedUpstream(wsPath)}
      {@const connectionBlockedLabel = getConnectionBlockedLabel(workspace)}
      {@const upstreamBlockedLabel = getUpstreamBlockedLabel(wsPath)}
      {@const readyForApply = isReadyForApply(workspace)}
      {@const requiresApproval = getRequiresApproval(workspace)}
      {@const isQueued = workspace.runs.length === 0 && (displayStatus === "queued" || displayStatus === "pending")}
      {@const isSubmitting = applyingWorkspaces.has(wsPath)}
      {@const btnWidth = 72}
      {@const btnHeight = 18}
      {@const btnRadius = 4}
      {@const ringRadius = 6}
      {@const circumference = 2 * Math.PI * ringRadius}
      {@const compactGlyph = compactWorkspaceGlyph(
        planStatus,
        applyStatus,
        planSummary,
        connectionBlockedLabel,
        upstreamBlockedLabel,
        isBlocked,
        displayStatus,
      )}

      <rect
        {width}
        {height}
        rx="6"
        class="node-bg transition-all"
        class:selected={isSelected}
        class:blocked={isBlocked}
        class:queued={isQueued}
        class:has-changes={hasChanges(planSummary)}
        class:out-of-scope={displayStatus === "out_of_scope"}
      />

      {#if compact}
        {@const compactLabelMax = compactLabelLimit(width)}
        <text x={NODE_PAD_X} y="16" class="node-status compact-node-status {compactGlyph.className}">
          <title>{compactGlyph.title}</title>
          {compactGlyph.icon}
        </text>
        <text x={NODE_PAD_X + 14} y="16" class="node-label compact-node-label">
          <title>{wsPath}</title>
          {truncateCopy(wsPath, compactLabelMax)}
        </text>
      {:else}
        <text x={NODE_PAD_X} y="18" class="node-label">
          <title>{wsPath}</title>
          {wsPath}
        </text>

        <g transform="translate({NODE_PAD_X}, 44)">
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
                onclick={(e) => { e.stopPropagation(); handlePause(wsPath) }}
                onkeydown={(e) => e.key === "Enter" && handlePause(wsPath)}
              >
                <title>{getTimerSecondsLeft(wsPath)}s until apply starts. Click to pause.</title>
                <rect x="0" y="0" width={btnWidth} height={btnHeight} rx={btnRadius} class="timer-btn-bg" />
                <g transform="translate(10, 9)">
                  <circle cx="0" cy="0" r={ringRadius} fill="none" stroke="var(--color-border)" stroke-width="1.5" />
                  <circle
                    cx="0"
                    cy="0"
                    r={ringRadius}
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
          {:else if readyForApply && requiresApproval && !isSubmitting}
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
          {:else if isSubmitting}
            <g class="submitting-btn">
              <rect x="0" y="0" width={btnWidth} height={btnHeight} rx={btnRadius} class="submitting-btn-bg" />
              <text x={btnWidth / 2} y="13" text-anchor="middle" class="submitting-btn-text">...</text>
            </g>
          {/if}

          {#if applyStatus === "running"}
            <text y="28" class="node-status text-status-applying">{statusIcon("running")} Applying...</text>
          {:else if applyStatus === "success"}
            <text y="28" class="node-status text-status-ready">{statusIcon("success")} Applied</text>
          {:else if applyStatus === "failed"}
            <text y="28" class="node-status text-status-error">{statusIcon("failed")} Apply failed</text>
          {:else if applyStatus === "cancelled"}
            <text y="28" class="node-status text-status-failed">{statusIcon("cancelled")} Apply cancelled</text>
          {:else if applyStatus === "skipped"}
            <text y="28" class="node-status text-status-ready">{statusIcon("success")} No changes</text>
          {:else if planStatus === "running"}
            <text y="28" class="node-status text-status-applying">{statusIcon("running")} Planning...</text>
          {:else if planStatus === "failed"}
            <text y="28" class="node-status text-status-failed">{statusIcon("failed")} Plan failed</text>
          {:else if planStatus === "cancelled"}
            <text y="28" class="node-status text-status-failed">{statusIcon("cancelled")} Plan cancelled</text>
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
          {:else if connectionBlockedLabel}
            <text y="28" class="node-status text-status-error">⚠ {connectionBlockedLabel}</text>
          {:else if upstreamBlockedLabel}
            <text y="28" class="node-status text-text-dim">{statusIcon("waiting")} {upstreamBlockedLabel}</text>
          {:else if isBlocked}
            {@const skippedCfg = statusConfig("skipped")}
            <text y="28" class="node-status {skippedCfg.color}">{skippedCfg.icon} {skippedCfg.label}</text>
          {:else}
            {@const fallbackCfg = statusConfig(displayStatus)}
            <text y="28" class="node-status {fallbackCfg.color}">{fallbackCfg.icon} {fallbackCfg.label}</text>
          {/if}
        </g>
      {/if}
    {:else if item.kind === "lifecycle"}
      {@const lifecycleStatus = nodeStatuses[item.id] ?? item.item.state}
      {@const lifecycleGlyph = compactLifecycleGlyph(lifecycleStatus)}
      <rect
        {width}
        {height}
        rx="10"
        class="node-bg transition-all lifecycle-node"
        class:selected={isSelected}
        class:lifecycle-activation={item.phase === "activation"}
        class:lifecycle-verification={item.phase === "verification"}
      />

      {#if compact}
        {@const compactLabelMax = compactLabelLimit(width)}
        <text x={NODE_PAD_X} y="16" class="node-status compact-node-status {lifecycleGlyph.className}">
          {lifecycleGlyph.icon}
        </text>
        <text x={NODE_PAD_X + 14} y="16" class="node-label lifecycle-node-label compact-node-label">
          <title>{item.key}</title>
          {truncateCopy(humanizeLifecycleKey(item.key), compactLabelMax)}
        </text>
      {:else}
        <text x={NODE_PAD_X} y="16" class="node-phase-label lifecycle-phase-label">
          {lifecyclePhaseIcon(item.phase)} {item.phase}
        </text>
        <text x={NODE_PAD_X} y="38" class="node-label lifecycle-node-label">
          <title>{item.key}</title>
          {truncateCopy(humanizeLifecycleKey(item.key), 24)}
        </text>
        <text x={NODE_PAD_X} y="58" class="node-status {lifecycleStatusClass(lifecycleStatus)} lifecycle-status-copy">
          {statusIcon(lifecycleStatus === "running" ? "running" : lifecycleStatus === "succeeded" ? "success" : lifecycleStatus)} {truncateCopy(lifecycleStatusText(item), 24)}
        </text>
        <text x={NODE_PAD_X} y="76" class="node-status lifecycle-node-subcopy">
          {truncateCopy(item.item.reason ?? lifecycleNodeScopeText(item), 28)}
        </text>
      {/if}
    {:else}
      {@const compactLabelMax = compactLabelLimit(width)}
      <rect {width} {height} rx="6" class="node-bg transition-all" class:selected={isSelected} />
      <text x={NODE_PAD_X} y={compact ? 16 : 18} class="node-label {compact ? 'compact-node-label' : ''}">
        {truncateCopy(item.workspacePath, compact ? compactLabelMax : 48)}
      </text>
    {/if}
  </g>
{/snippet}

<DagLayout
  items={dagNodes}
  {getId}
  {dependencyGraph}
  selectedId={selectedPath}
  estimateWidth={estimateTextWidth}
  nodeHeight={NODE_HEIGHT}
  nodeGapX={NODE_GAP_X}
  nodeGapY={NODE_GAP_Y}
  minColumnWidth={MIN_COLUMN_WIDTH}
  horizontalFirst={true}
  layoutMode="cli"
  {node}
/>

<style>
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

  .node-bg.queued {
    fill: color-mix(in srgb, var(--color-surface-overlay) 70%, transparent);
    stroke-dasharray: 3 3;
    stroke-opacity: 0.6;
  }
  
  .node-bg.has-changes {
    stroke: var(--color-status-pending);
    stroke-width: 1.5;
  }

  .node-bg.out-of-scope {
    fill: color-mix(in srgb, var(--color-surface-overlay) 88%, black 12%);
    stroke: color-mix(in srgb, var(--color-border) 80%, transparent 20%);
    stroke-dasharray: 3 2;
    opacity: 0.7;
  }

  .node-bg.lifecycle-node {
    fill: color-mix(in srgb, var(--color-surface-overlay) 78%, var(--color-yaffle-500) 22%);
    stroke-width: 1.2;
  }

  .node-bg.lifecycle-node.lifecycle-activation {
    stroke: color-mix(in srgb, var(--color-status-ready) 50%, var(--color-border));
    fill: color-mix(in srgb, var(--color-surface-overlay) 82%, var(--color-status-ready) 18%);
  }

  .node-bg.lifecycle-node.lifecycle-verification {
    stroke: color-mix(in srgb, var(--color-status-pending) 55%, var(--color-border));
    fill: color-mix(in srgb, var(--color-surface-overlay) 82%, var(--color-status-pending) 18%);
  }
  


  .node-label {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    fill: var(--color-text);
  }

  .compact-node-label {
    font-size: 8px;
  }

  .node-phase-label {
    font-family: var(--font-mono, monospace);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .compact-phase-label {
    font-size: 8px;
    letter-spacing: 0.06em;
  }

  .lifecycle-phase-label {
    fill: var(--color-text-dim);
    font-weight: 700;
  }

  .lifecycle-node-label {
    font-size: 12px;
    font-weight: 700;
  }

  .lifecycle-status-copy {
    font-size: 10px;
    font-weight: 600;
  }

  .lifecycle-node-subcopy {
    fill: var(--color-text-dim);
    font-size: 9px;
  }

  .node-status {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    fill: var(--color-text-muted);
  }

  .compact-node-status {
    font-size: 7px;
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
    fill: #c49a2a;
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

  /* Submitting state (after clicking Approve, before apply starts) */
  .submitting-btn-bg {
    fill: var(--color-text-dim);
    fill-opacity: 0.1;
    stroke: var(--color-text-dim);
    stroke-width: 1;
  }
  
  .submitting-btn-text {
    font-family: var(--font-mono, monospace);
    font-size: 9px;
    fill: var(--color-text-dim);
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
