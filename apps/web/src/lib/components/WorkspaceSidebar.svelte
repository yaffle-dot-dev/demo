<script lang="ts">
  import type { WorkspaceWithRuns, Run } from "$lib/api"

  interface Props {
    workspaces: WorkspaceWithRuns[]
    selectedPath: string
    onSelect: (path: string) => void
  }

  let props: Props = $props()

  const workspaces = $derived(props.workspaces)
  const selectedPath = $derived(props.selectedPath)
  const onSelect = $derived(props.onSelect)

  function getRunStatus(workspace: WorkspaceWithRuns, runType: "plan" | "apply"): string | null {
    const run = workspace.runs.find((r: Run) => r.runType === runType)
    return run?.status ?? null
  }

  // Standard icons: + ok, x fail, ~ pending, ... in progress
  function statusIcon(status: string | null): string {
    if (!status) return "~"
    switch (status) {
      case "success": return "+"
      case "running": return "..."
      case "pending": return "~"
      case "failed": return "x"
      case "cancelled": return "x"
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
      default: return "text-text-muted"
    }
  }

  function shortenPath(path: string): string {
    // Show last 2 segments for readability
    const parts = path.split("/")
    if (parts.length <= 2) return path
    return ".../" + parts.slice(-2).join("/")
  }
</script>

<div class="flex flex-col h-full">
  <nav class="flex-1 overflow-y-auto">
    {#each workspaces as workspace (workspace.preview.id)}
      {@const isSelected = workspace.preview.workspacePath === selectedPath}
      {@const planStatus = getRunStatus(workspace, "plan")}
      {@const applyStatus = getRunStatus(workspace, "apply")}

      <button
        class="w-full text-left px-3 py-2 transition-colors border-l-2
               {isSelected 
                 ? 'bg-surface-overlay border-yaffle-500' 
                 : 'border-transparent hover:bg-surface-raised'}"
        onclick={() => onSelect(workspace.preview.workspacePath)}
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-mono text-xs text-text truncate" title={workspace.preview.workspacePath}>
              {shortenPath(workspace.preview.workspacePath)}
            </div>
            <!-- Plan/Apply status indicators from runs in this run group -->
            <div class="flex items-center gap-1 text-[10px] font-mono mt-1">
              <span class={statusColor(planStatus)} title="Plan: {planStatus ?? 'none'}">
                P:{statusIcon(planStatus)}
              </span>
              <span class={statusColor(applyStatus)} title="Apply: {applyStatus ?? 'none'}">
                A:{statusIcon(applyStatus)}
              </span>
            </div>
          </div>

          <!-- Selection indicator -->
          {#if isSelected}
            <span class="text-yaffle-500 text-xs mt-0.5">*</span>
          {/if}
        </div>
      </button>
    {/each}
  </nav>

  {#if workspaces.length === 0}
    <div class="px-3 py-4 text-text-dim text-xs text-center">
      No runs yet
    </div>
  {/if}
</div>
