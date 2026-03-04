<script lang="ts">
  import { page } from "$app/stores"
  import { goto } from "$app/navigation"
  import type { WorkspaceWithRuns, Run } from "$lib/api"
  import { shortSha, statusConfig, formatRelativeTime } from "$lib/status"
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
  }

  let {
    type,
    org,
    repo,
    identifier,
    branch,
    headSha,
    authorLogin = null,
    workspaces,
    githubUrl,
    streaming = false,
  }: Props = $props()

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

  // Get latest runs for the selected workspace
  const latestPlan = $derived(
    selectedWorkspace?.runs.find((r: Run) => r.runType === "plan")
  )
  const latestApply = $derived(
    selectedWorkspace?.runs.find((r: Run) => r.runType === "apply")
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

  const tabs = $derived.by((): Tab[] => {
    const result: Tab[] = []
    if (latestPlan) {
      result.push({ id: "plan", label: "Plan", status: latestPlan.status })
    }
    if (latestApply) {
      result.push({ id: "apply", label: "Apply", status: latestApply.status })
    }
    if (hasOutputs) {
      result.push({ id: "outputs", label: "Outputs" })
    }
    return result
  })

  // Auto-select first available tab if current isn't available
  $effect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.id === activeTab)) {
      activeTab = tabs[0].id
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
        {workspaces}
        {selectedPath}
        onSelect={handleWorkspaceSelect}
      />
    </aside>

    <!-- Content area -->
    <main class="flex-1 flex flex-col min-w-0 overflow-hidden">
      {#if selectedWorkspace}
        <!-- Workspace header -->
        {@const cfg = statusConfig(selectedWorkspace.preview.status)}
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
