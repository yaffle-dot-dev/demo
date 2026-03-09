<script lang="ts">
  import { page } from "$app/stores"
  import { goto } from "$app/navigation"
  import { untrack } from "svelte"
  import type { WorkspaceWithRuns, Run } from "$lib/api"
  import { shortSha, statusConfig, formatRelativeTime } from "$lib/status"
  import { filterWorkspacesToCurrentCycle, filterToCurrentCycle } from "$lib/sse/types"
  import WorkspaceSidebar from "./WorkspaceSidebar.svelte"
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
    githubUrl: string
    streaming?: boolean
    /** When set, display this specific run instead of the latest */
    viewedRunId?: string | null
    /** Whether a newer run exists beyond the pinned view */
    hasNewerRun?: boolean
    /** Latest head SHA (for showing in new run badge) */
    latestHeadSha?: string | null
    /** Callback to unpin and switch to latest run */
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
  const githubUrl = $derived(props.githubUrl)
  const streaming = $derived(props.streaming ?? false)
  const viewedRunId = $derived(props.viewedRunId ?? null)
  const hasNewerRun = $derived(props.hasNewerRun ?? false)
  const latestHeadSha = $derived(props.latestHeadSha ?? null)
  const onSwitchToLatest = $derived(props.onSwitchToLatest ?? null)

  // Selected workspace from URL query param or first workspace
  let selectedPath = $derived.by(() => {
    const wsParam = $page.url.searchParams.get("ws")
    if (wsParam && workspaces.some((w) => w.preview.workspacePath === wsParam)) {
      return wsParam
    }
    return workspaces[0]?.preview.workspacePath ?? ""
  })

  // Current workspace data
  const selectedWorkspace = $derived(
    workspaces.find((w) => w.preview.workspacePath === selectedPath)
  )

  // Tab state
  type TabId = "plan" | "apply" | "outputs"
  let activeTab = $state<TabId>("plan")

  // When viewedRunId is set, find it across ALL workspaces to get the timestamp boundary
  const pinnedRun = $derived.by((): Run | null => {
    if (!viewedRunId) return null
    for (const ws of workspaces) {
      const run = ws.runs.find((r: Run) => r.id === viewedRunId)
      if (run) return run
    }
    return null
  })

  // The timestamp boundary: when pinned, only show runs created at or before this time
  const pinnedBoundary = $derived(pinnedRun?.createdAt ?? null)

  // Filter runs to the appropriate cycle:
  // - When pinned: show runs from the pinned cycle
  // - When not pinned: show only current cycle (no stale applies)
  const visibleRuns = $derived.by((): Run[] => {
    const runs = selectedWorkspace?.runs ?? []
    if (pinnedBoundary) {
      return runs.filter((r: Run) => r.createdAt <= pinnedBoundary)
    }
    return filterToCurrentCycle(runs)
  })

  // Workspaces for sidebar: filter runs to the appropriate cycle
  // - When pinned: show runs from the pinned cycle (created at or before pinned run)
  // - When not pinned: show only current cycle runs (no stale applies from previous pushes)
  const sidebarWorkspaces = $derived.by((): WorkspaceWithRuns[] => {
    if (pinnedBoundary) {
      // Pinned: show runs up to the pinned timestamp
      return workspaces.map((ws) => ({
        ...ws,
        runs: ws.runs.filter((r: Run) => r.createdAt <= pinnedBoundary),
      }))
    }
    // Not pinned: show only current cycle (filters out stale applies)
    return filterWorkspacesToCurrentCycle(workspaces)
  })

  // Get latest plan/apply from the visible (possibly filtered) runs
  const latestPlan = $derived(
    visibleRuns.find((r: Run) => r.runType === "plan") ?? undefined,
  )
  const latestApply = $derived(
    visibleRuns.find((r: Run) => r.runType === "apply") ?? undefined,
  )
  const hasOutputs = $derived(
    latestApply?.status === "success" && selectedWorkspace?.outputs
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

  function handleWorkspaceSelect(path: string) {
    const url = new URL($page.url)
    url.searchParams.set("ws", path)
    goto(url.toString(), { replaceState: true, noScroll: true })
  }

  function tabStatusIcon(status?: string): string {
    if (!status) return ""
    switch (status) {
      case "success": return " ok"
      case "running": return " .."
      case "pending": return " ~"
      case "failed": return " !"
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
      default: return "text-text-muted"
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
            <span class="text-text-muted">{org}/</span>{repo.split("/").pop()}
          </h1>
          {#if type === "pr"}
            <span class="text-text-muted">PR #{identifier}</span>
          {:else}
            <span class="px-2 py-0.5 bg-surface-overlay rounded text-xs text-text-muted">
              {identifier}
            </span>
          {/if}
        </div>
        <div class="flex items-center gap-3 text-sm text-text-muted">
          <span class="font-mono text-xs">{branch}</span>
          <span class="text-text-dim">@</span>
          <span class="font-mono text-xs text-text-dim">{shortSha(headSha)}</span>
          {#if authorLogin}
            <span class="text-text-dim">by {authorLogin}</span>
          {/if}
        </div>
      </div>
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-text-muted hover:text-text transition-colors flex items-center gap-1.5"
      >
        GitHub
        <span class="text-xs">-></span>
      </a>
    </div>
  </header>

  <!-- Main content -->
  <div class="flex-1 flex min-h-0">
    <!-- Sidebar -->
    <aside class="w-56 flex-shrink-0 border-r border-border bg-surface overflow-hidden">
      <WorkspaceSidebar
        workspaces={sidebarWorkspaces}
        {selectedPath}
        onSelect={handleWorkspaceSelect}
      />
    </aside>

    <!-- Content area -->
    <main class="flex-1 flex flex-col min-w-0 overflow-hidden">
      {#if selectedWorkspace}
        <!-- Workspace header: when pinned, derive status from visible runs -->
        {@const displayStatus = pinnedBoundary
          ? (latestApply?.status === "success" ? "ready"
            : latestApply?.status === "running" ? "applying"
            : latestPlan?.status === "success" ? "planned"
            : latestPlan?.status === "running" ? "planning"
            : selectedWorkspace.preview.status)
          : selectedWorkspace.preview.status}
        {@const cfg = statusConfig(displayStatus)}
        <div class="flex-shrink-0 px-6 py-4 border-b border-border">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="font-mono text-sm text-text">{selectedWorkspace.preview.workspacePath}</h2>
              <div class="flex items-center gap-2 mt-1">
                <span class="text-xs {cfg.color}">{cfg.icon} {cfg.label}</span>
                {#if selectedWorkspace.preview.requireApproval}
                  <span class="text-xs text-status-planning px-1.5 py-0.5 bg-status-planning/10 rounded">
                    requires approval
                  </span>
                {/if}
              </div>
            </div>
            {#if hasNewerRun && onSwitchToLatest}
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
            {/if}
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
            <OutputsView outputs={selectedWorkspace.outputs as Record<string, {value: unknown, sensitive?: boolean}> | null} />
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
        <div class="flex-1 flex items-center justify-center text-text-dim">
          Select a workspace to view details.
        </div>
      {/if}
    </main>
  </div>
</div>
