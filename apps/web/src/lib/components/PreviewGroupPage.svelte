<script lang="ts">
  import { page } from "$app/stores"
  import { goto } from "$app/navigation"
  import { untrack } from "svelte"
  import type { WorkspaceWithRuns, Run, RunGroup } from "$lib/api"
  import { cancelRun, rerunPreview } from "$lib/api"
  import { shortSha, statusConfig, formatRelativeTime } from "$lib/status"
  import {
    getWorkspacesInRunGroup,
    getLatestRunGroup,
  } from "$lib/sse/types"
  import DagVisualization from "./DagVisualization.svelte"
  import Terminal from "./Terminal.svelte"
  import PlanSummary from "./PlanSummary.svelte"
  import OutputsView from "./OutputsView.svelte"

  interface Props {
    type: "pr" | "env"
    org: string
    repo: string
    identifier: number | string // PR number or branch name
    branch: string
    headSha: string
    authorLogin?: string | null
    workspaces: WorkspaceWithRuns[]
    runGroups: RunGroup[]
    githubUrl: string
    streaming?: boolean
    /** When set, display this specific run group instead of the latest */
    viewedRunGroupId?: string | null
    /** Whether a newer run group exists beyond the pinned view */
    hasNewerRunGroup?: boolean
    /** Latest head SHA (for showing in new run badge) */
    latestHeadSha?: string | null
    /** Callback to unpin and switch to latest run group */
    onSwitchToLatest?: () => void
  }

  let props: Props = $props()

  // Explicitly derive frequently-changing props so downstream $derived chains react
  const type = $derived(props.type)
  const org = $derived(props.org)
  const repo = $derived(props.repo)
  const identifier = $derived(props.identifier)
  const branch = $derived(props.branch)
  const headSha = $derived(props.headSha)
  const authorLogin = $derived(props.authorLogin ?? null)
  const workspaces = $derived(props.workspaces)
  const runGroups = $derived(props.runGroups ?? [])
  const githubUrl = $derived(props.githubUrl)
  const streaming = $derived(props.streaming ?? false)
  const viewedRunGroupId = $derived(props.viewedRunGroupId ?? null)
  const hasNewerRunGroup = $derived(props.hasNewerRunGroup ?? false)
  const latestHeadSha = $derived(props.latestHeadSha ?? null)
  const onSwitchToLatest = $derived(props.onSwitchToLatest ?? null)

  // Get the run group we're viewing
  const viewedRunGroup = $derived.by((): RunGroup | null => {
    if (viewedRunGroupId) {
      return runGroups.find((rg) => rg.id === viewedRunGroupId) ?? null
    }
    // Not pinned: show latest run group (prefer current/running, then latest)
    const current = runGroups.find((rg) => rg.status === "running" || rg.status === "pending")
    return current ?? runGroups[0] ?? null
  })

  // Workspaces filtered to the viewed run group
  // Only show workspaces that have runs in the viewed run group
  const filteredWorkspaces = $derived.by((): WorkspaceWithRuns[] => {
    if (!viewedRunGroup) {
      // No run groups yet, show no workspaces
      return []
    }
    // Only show workspaces that have runs in this run group
    return getWorkspacesInRunGroup(workspaces, viewedRunGroup.id)
  })

  // Helper: check if a workspace has an actively running run (not just pending)
  function isWorkspaceActivelyRunning(ws: WorkspaceWithRuns): boolean {
    return ws.runs.some((r) => r.status === "running")
  }

  // Helper: check if a workspace has any in-progress run (running or pending)
  function isWorkspaceInProgress(ws: WorkspaceWithRuns): boolean {
    return ws.runs.some((r) => r.status === "running" || r.status === "pending")
  }

  // Follow mode: auto-follow the running workspace unless user manually selected one
  // Starts true, becomes false when user clicks a workspace
  let followMode = $state(true)

  // Track the last run group ID to detect run group changes
  let lastSeenRunGroupId: string | null = null

  // Track the last workspace we followed (to stay on it when nothing is running)
  let lastFollowedPath: string | null = null

  // Get the currently running workspace (for follow mode)
  // Prefer actively running over pending
  const runningWorkspace = $derived.by(() => {
    // First, find a workspace with an actively running run
    const activelyRunning = filteredWorkspaces.find(isWorkspaceActivelyRunning)
    if (activelyRunning) return activelyRunning
    // Fall back to any workspace with pending runs
    return filteredWorkspaces.find(isWorkspaceInProgress) ?? null
  })

  // Is there any workspace in progress? (for showing follow button)
  const hasAnyInProgress = $derived(
    filteredWorkspaces.some(isWorkspaceInProgress)
  )

  // Selected workspace: follows running workspace in follow mode, or respects URL
  let selectedPath = $derived.by(() => {
    const wsParam = $page.url.searchParams.get("ws")
    const wsFromUrl = filteredWorkspaces.find((w) => w.preview.workspacePath === wsParam)

    // In follow mode with a running workspace, follow it
    if (followMode && runningWorkspace) {
      return runningWorkspace.preview.workspacePath
    }

    // In follow mode but nothing running - stay on last followed workspace if it exists
    if (followMode && lastFollowedPath) {
      const lastWs = filteredWorkspaces.find((w) => w.preview.workspacePath === lastFollowedPath)
      if (lastWs) {
        return lastFollowedPath
      }
    }

    // Not in follow mode or no valid workspace: use URL param or first workspace
    if (wsParam && wsFromUrl) {
      return wsParam
    }
    return filteredWorkspaces[0]?.preview.workspacePath ?? ""
  })

  // Track the last followed workspace when in follow mode
  $effect(() => {
    if (followMode && runningWorkspace) {
      lastFollowedPath = runningWorkspace.preview.workspacePath
    }
  })

  // Re-enable follow mode when switching to a new run group
  $effect(() => {
    const currentRunGroupId = viewedRunGroup?.id ?? null
    if (currentRunGroupId && currentRunGroupId !== lastSeenRunGroupId) {
      lastSeenRunGroupId = currentRunGroupId
      // Re-enable follow mode and clear last followed path on run group change
      followMode = true
      lastFollowedPath = null
    }
  })

  // Handle workspace selection - disables follow mode
  function handleWorkspaceSelect(path: string) {
    // Disable follow mode when user manually selects
    followMode = false
    const url = new URL($page.url)
    url.searchParams.set("ws", path)
    goto(url.toString(), { replaceState: true, noScroll: true })
  }

  // Re-enable follow mode
  function enableFollowMode() {
    followMode = true
  }

  // Current workspace data (from filtered workspaces)
  const selectedWorkspace = $derived(
    filteredWorkspaces.find((w) => w.preview.workspacePath === selectedPath)
  )

  // Tab state
  type TabId = "plan" | "apply" | "outputs"
  let activeTab = $state<TabId>("plan")
  
  // Cancel state
  let cancellingRunId = $state<string | null>(null)
  let cancelError = $state<string | null>(null)

  // Rerun state
  let rerunning = $state(false)
  let rerunError = $state<string | null>(null)

  // Visible runs for the selected workspace (already filtered by run group)
  const visibleRuns = $derived(selectedWorkspace?.runs ?? [])

  // Get latest plan/apply from the visible (possibly filtered) runs
  const latestPlan = $derived(
    visibleRuns.find((r: Run) => r.runType === "plan") ?? undefined,
  )
  const latestApply = $derived(
    visibleRuns.find((r: Run) => r.runType === "apply") ?? undefined,
  )
  // Show outputs tab if apply succeeded or was skipped
  const hasOutputs = $derived(
    latestApply?.status === "success" || latestApply?.status === "skipped"
  )

  // Get the outputs to display - prefer current apply's outputs, fall back to workspace outputs
  const displayOutputs = $derived(
    latestApply?.outputs ?? selectedWorkspace?.outputs
  )

  // Available tabs based on what data exists
  interface Tab {
    id: TabId
    label: string
    status?: string
  }

  // The apply is stale if it's from a previous run cycle (older than the latest plan)
  const applyIsStale = $derived(
    latestPlan && latestApply && latestApply.createdAt < latestPlan.createdAt,
  )

  const tabs = $derived.by((): Tab[] => {
    const result: Tab[] = []
    if (latestPlan) {
      result.push({ id: "plan", label: "Plan", status: latestPlan.status })
    }
    if (latestApply && !applyIsStale) {
      result.push({ id: "apply", label: "Apply", status: latestApply.status })
    }
    if (hasOutputs && !applyIsStale) {
      result.push({ id: "outputs", label: "Outputs" })
    }
    return result
  })

  // Auto-select tab: switch to apply when plan finishes and apply starts
  $effect(() => {
    if (tabs.length === 0) return
    // Use untrack to read activeTab without creating a dependency on it
    // This prevents infinite loops when we write to activeTab
    const currentTab = untrack(() => activeTab)
    // If current tab isn't available, pick the first one
    if (!tabs.some((t) => t.id === currentTab)) {
      activeTab = tabs[0].id
      return
    }
    // Auto-switch from plan to apply when apply is running/pending
    if (currentTab === "plan" && latestPlan?.status === "success" && latestApply) {
      if (latestApply.status === "running" || latestApply.status === "pending") {
        activeTab = "apply"
      }
    }
  })

  // Get terminal output for current tab
  const terminalOutput = $derived.by(() => {
    if (activeTab === "plan" && latestPlan) {
      return latestPlan.logOutput ?? latestPlan.planSummary ?? ""
    }
    if (activeTab === "apply" && latestApply) {
      return latestApply.logOutput ?? ""
    }
    return ""
  })

  // Get plan JSON for plan summary view
  const planJson = $derived.by(() => {
    // Plan JSON would come from the run, but we need to fetch it separately
    // For now, return null - we'll show terminal output
    return null
  })

  // Standard icons: ✓ ok, ✗ fail, ~ pending, ... in progress, - skipped
  function tabStatusIcon(status?: string): string {
    if (!status) return ""
    switch (status) {
      case "success": return " ✓"
      case "running": return " ..."
      case "pending": return " ~"
      case "failed": return " ✗"
      case "skipped": return " -"
      default: return ""
    }
  }

  function tabStatusColor(status?: string): string {
    if (!status) return ""
    switch (status) {
      case "success": return "text-status-ready"
      case "running": return "text-status-applying"
      case "pending": return "text-status-pending"
      case "failed": return "text-status-failed"
      case "skipped": return "text-text-muted"
      default: return "text-text-muted"
    }
  }

  // Get the currently running run (if any) - check both plan and apply
  const runningRun = $derived.by((): Run | null => {
    if (latestPlan?.status === "running") return latestPlan
    if (latestApply?.status === "running") return latestApply
    return null
  })

  async function handleCancel() {
    if (!runningRun) return
    
    const runType = runningRun.runType === "apply" ? "apply" : "plan"
    const confirmed = confirm(`Cancel the running ${runType}? This will send SIGINT to terraform for graceful shutdown.`)
    if (!confirmed) return
    
    cancellingRunId = runningRun.id
    cancelError = null
    
    try {
      await cancelRun(runningRun.id)
    } catch (err) {
      cancelError = err instanceof Error ? err.message : "Failed to cancel run"
    } finally {
      cancellingRunId = null
    }
  }

  async function handleRerun() {
    if (!selectedWorkspace) return
    
    rerunning = true
    rerunError = null
    
    try {
      await rerunPreview(selectedWorkspace.preview.id)
      // The SSE stream will update with the new run automatically
    } catch (err) {
      rerunError = err instanceof Error ? err.message : "Failed to start re-run"
    } finally {
      rerunning = false
    }
  }

  // Check if a rerun is possible (no run in progress)
  const canRerun = $derived(!runningRun && selectedWorkspace && !rerunning)

  // Build workspace name matching server-side logic
  function buildWorkspaceName(environment: string, identifier: string, workspacePath: string): string {
    const pathSlug = workspacePath.replace(/\//g, "-").replace(/[^a-z0-9-]/gi, "")
    return `${environment}-${identifier}-${pathSlug}`
  }

  // Generate the backend config block for local tofu usage
  const backendConfig = $derived.by(() => {
    if (!selectedWorkspace) return null
    
    const workspacePath = selectedWorkspace.preview.workspacePath
    let workspaceName: string
    
    if (type === "pr") {
      workspaceName = buildWorkspaceName("preview", `pr-${identifier}`, workspacePath)
    } else {
      // Branch workspace: uses branch as both environment and identifier
      workspaceName = buildWorkspaceName(String(identifier), String(identifier), workspacePath)
    }
    
    // Use current hostname for the TFC API
    const hostname = typeof window !== "undefined" ? window.location.host : "api.yaffle.dev"
    
    return `# terraform login ${hostname}
terraform {
  cloud {
    hostname     = "${hostname}"
    organization = "${org}"

    workspaces {
      name = "${workspaceName}"
    }
  }
}`
  })

  let copiedBackend = $state(false)
  
  async function handleCopyBackend() {
    if (!backendConfig) return
    
    try {
      await navigator.clipboard.writeText(backendConfig)
      copiedBackend = true
      setTimeout(() => copiedBackend = false, 2000)
    } catch (err) {
      console.error("Failed to copy backend config:", err)
    }
  }
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <header class="flex-shrink-0 border-b border-border px-6 py-4">
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-3 mb-1">
          <h1 class="text-lg font-semibold">
            <a 
              href="https://github.com/{repo}" 
              target="_blank" 
              rel="noopener noreferrer"
              class="hover:text-yaffle-400 transition-colors"
            >
              <span class="text-text-muted">{org}/</span>{repo.split("/").pop()}
            </a>
          </h1>
          {#if type === "pr"}
            <a 
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="text-text-muted hover:text-yaffle-400 transition-colors"
            >
              PR #{identifier}
            </a>
          {:else}
            <a
              href="https://github.com/{repo}/tree/{branch}"
              target="_blank"
              rel="noopener noreferrer"
              class="px-2 py-0.5 bg-surface-overlay rounded text-xs text-text-muted hover:text-yaffle-400 transition-colors"
            >
              {identifier}
            </a>
          {/if}
        </div>
        <div class="flex items-center gap-3 text-sm text-text-muted">
          <a
            href="https://github.com/{repo}/tree/{branch}"
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-xs hover:text-yaffle-400 transition-colors"
          >
            {branch}
          </a>
          <span class="text-text-dim">@</span>
          <a
            href="https://github.com/{repo}/commit/{viewedRunGroup?.headSha ?? headSha}"
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-xs text-text-dim hover:text-yaffle-400 transition-colors"
          >
            {shortSha(viewedRunGroup?.headSha ?? headSha)}
          </a>
          {#if authorLogin}
            <span class="text-text-dim">by</span>
            <a
              href="https://github.com/{authorLogin}"
              target="_blank"
              rel="noopener noreferrer"
              class="text-text-dim hover:text-yaffle-400 transition-colors"
            >
              {authorLogin}
            </a>
          {/if}
        </div>
      </div>
    </div>
  </header>

  <!-- Main content -->
  <div class="flex-1 flex flex-col min-h-0">
    <!-- DAG Visualization (replaces sidebar) -->
    <div class="flex-shrink-0 border-b border-border bg-surface">
      <div class="px-4 py-2 flex items-center justify-between">
        <span class="text-xs text-text-dim font-medium uppercase tracking-wider">Workspaces</span>
        {#if hasAnyInProgress && !followMode}
          <button
            onclick={enableFollowMode}
            class="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay hover:bg-yaffle-500/20 text-text-muted hover:text-yaffle-400 transition-colors"
            title="Auto-follow running workspace"
          >
            follow
          </button>
        {:else if followMode && hasAnyInProgress}
          <span class="text-[10px] text-yaffle-400" title="Following running workspace">
            following
          </span>
        {/if}
      </div>
      <DagVisualization
        workspaces={filteredWorkspaces}
        dependencyGraph={viewedRunGroup?.dependencyGraph ?? null}
        {selectedPath}
        onSelect={handleWorkspaceSelect}
      />
    </div>

    <!-- Content area -->
    <main class="flex-1 flex flex-col min-w-0 overflow-hidden">
      {#if selectedWorkspace}
        <!-- Workspace header: derive status from the run group / visible runs -->
        {@const displayStatus = viewedRunGroup
          ? (latestApply?.status === "success" ? "ready"
            : latestApply?.status === "skipped" ? "ready"
            : latestApply?.status === "running" ? "applying"
            : latestPlan?.status === "success" ? "planned"
            : latestPlan?.status === "running" ? "planning"
            : latestPlan?.status === "pending" ? "pending"
            : selectedWorkspace.preview.status)
          : selectedWorkspace.preview.status}
        {@const cfg = statusConfig(displayStatus)}
        <div class="flex-shrink-0 px-6 py-4 border-b border-border">
          <div class="flex items-center justify-between">
            <div>
              <div class="flex items-center gap-1.5">
                <h2 class="font-mono text-sm text-text">{selectedWorkspace.preview.workspacePath}</h2>
                <button
                  onclick={handleCopyBackend}
                  class="p-1 text-text-dim hover:text-text rounded transition-colors"
                  title="Copy backend configuration"
                >
                  {#if copiedBackend}
                    <svg class="w-3.5 h-3.5 text-status-ready" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <rect x="5" y="5" width="8" height="10" rx="1"/>
                      <path d="M3 11V3a1 1 0 0 1 1-1h6"/>
                    </svg>
                  {/if}
                </button>
              </div>
              <div class="flex items-center gap-2 mt-1">
                <span class="text-xs {cfg.color}">{cfg.icon} {cfg.label}</span>
                {#if selectedWorkspace.preview.requireApproval}
                  <span class="text-xs text-status-planning px-1.5 py-0.5 bg-status-planning/10 rounded">
                    requires approval
                  </span>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-2">
              {#if runningRun}
                <!-- Cancel button for running runs -->
                <button
                  onclick={handleCancel}
                  disabled={cancellingRunId !== null}
                  class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs
                         text-text-muted hover:text-status-failed hover:bg-status-failed/10 
                         rounded transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Cancel running {runningRun.runType}"
                >
                  {#if cancellingRunId === runningRun.id}
                    <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="8" cy="8" r="6" stroke-opacity="0.3"/>
                      <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"/>
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="8" cy="8" r="6"/>
                      <path d="M6 6l4 4M10 6l-4 4" stroke-linecap="round"/>
                    </svg>
                  {/if}
                  <span>{cancellingRunId === runningRun.id ? "cancelling" : "cancel"}</span>
                </button>
              {:else if hasNewerRunGroup && onSwitchToLatest}
                <!-- New run available - show button to switch to it -->
                <button
                  onclick={onSwitchToLatest}
                  class="flex items-center gap-2 px-3 py-1.5 bg-status-planning/15 hover:bg-status-planning/25 border border-status-planning/30 rounded text-status-planning transition-colors"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M2 8a6 6 0 0 1 10.2-4.3M14 8a6 6 0 0 1-10.2 4.3" stroke-linecap="round"/>
                    <path d="M12 1v3.5h-3.5M4 15v-3.5h3.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <div class="text-left">
                    <div class="text-xs font-medium leading-tight">new run</div>
                    {#if latestHeadSha}
                      <div class="font-mono text-[10px] leading-tight opacity-75">{shortSha(latestHeadSha)}</div>
                    {/if}
                  </div>
                </button>
              {:else if canRerun}
                <!-- Run again button for completed runs -->
                <button
                  onclick={handleRerun}
                  disabled={rerunning}
                  class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs
                         text-text-muted hover:text-status-planning hover:bg-status-planning/10 
                         rounded transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Re-run plan and apply"
                >
                  {#if rerunning}
                    <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="8" cy="8" r="6" stroke-opacity="0.3"/>
                      <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"/>
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M2 8a6 6 0 0 1 10.2-4.3M14 8a6 6 0 0 1-10.2 4.3" stroke-linecap="round"/>
                      <path d="M12 1v3.5h-3.5M4 15v-3.5h3.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {/if}
                  <span>{rerunning ? "starting..." : "run again"}</span>
                </button>
              {/if}
              {#if cancelError}
                <span class="text-xs text-status-failed">{cancelError}</span>
              {/if}
              {#if rerunError}
                <span class="text-xs text-status-failed">{rerunError}</span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Tabs -->
        {#if tabs.length > 0}
          <div class="flex-shrink-0 border-b border-border px-6">
            <div class="flex gap-4">
              {#each tabs as tab (tab.id)}
                <button
                  class="pb-2 text-sm font-medium transition-colors border-b-2 -mb-px
                         {activeTab === tab.id 
                           ? 'border-yaffle-500 text-text' 
                           : 'border-transparent text-text-muted hover:text-text'}"
                  onclick={() => activeTab = tab.id}
                >
                  {tab.label}
                  {#if tab.status}
                    <span class="font-mono text-xs {tabStatusColor(tab.status)}">
                      {tabStatusIcon(tab.status)}
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Tab content -->
        <div class="flex-1 overflow-auto p-6">
          {#if activeTab === "outputs" && hasOutputs}
            <OutputsView outputs={displayOutputs as Record<string, {value: unknown, sensitive?: boolean}> | null} />
          {:else if activeTab === "plan" && latestPlan}
            <!-- Show terminal with plan output -->
            <!-- Key by workspace+tab to force re-mount when switching -->
            {#key `${selectedPath}-plan`}
              <div class="h-[500px]">
                <Terminal output={terminalOutput} {streaming} />
              </div>
            {/key}
          {:else if activeTab === "apply" && latestApply}
            <!-- Show terminal with apply output -->
            {#key `${selectedPath}-apply`}
              <div class="h-[500px]">
                <Terminal output={terminalOutput} {streaming} />
              </div>
            {/key}
          {:else}
            <div class="text-text-dim text-sm text-center py-8">
              No data available for this tab.
            </div>
          {/if}
        </div>
      {:else}
        <div class="flex-1 flex flex-col items-center justify-center text-text-dim gap-2">
          {#if filteredWorkspaces.length === 0}
            <svg class="w-12 h-12 text-text-dim/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <p class="text-sm">No runs yet</p>
            <p class="text-xs text-text-dim/75">Runs will appear here when triggered by a push or PR event.</p>
          {:else}
            <p>Select a workspace to view details.</p>
          {/if}
        </div>
      {/if}
    </main>
  </div>
</div>
