<script lang="ts">
  /**
   * WorkspaceDag - Compact DAG visualization of workspaces.
   * Used on the dashboard to show workspace status and dependencies.
   *
   * Wraps DagLayout with workspace-specific rendering and navigation support.
   * Accepts any workspace-like object with workspacePath and status fields.
   * Shows full workspace paths and lays out horizontally first when no dependencies.
   */
  import { base } from "$app/paths"
  import { goto } from "$app/navigation"
  import type { DependencyGraph } from "$lib/api"
  import { statusConfig } from "$lib/status"
  import DagLayout from "./DagLayout.svelte"

  /** Minimal workspace shape required for visualization */
  interface WorkspaceLike {
    workspacePath: string
    status: string
  }

  interface Props {
    /** Organization slug */
    org: string
    /** Repository name */
    repo: string
    /** Environment name (e.g., "pr-123" or "main") */
    environmentName: string
    /** Workspaces to display - any object with workspacePath and status */
    workspaces: WorkspaceLike[]
    /** Optional dependency graph */
    dependencyGraph?: DependencyGraph | null
    /** Currently selected workspace path */
    selectedPath?: string
  }

  let {
    org,
    repo,
    environmentName,
    workspaces,
    dependencyGraph = null,
    selectedPath = "",
  }: Props = $props()

  // Navigate to workspace detail
  function navigateTo(ws: WorkspaceLike) {
    const url = `${base}/${org}/${repo}/env/${environmentName}?ws=${encodeURIComponent(ws.workspacePath)}`
    goto(url)
  }

  // Get unique ID for DAG layout
  function getId(ws: WorkspaceLike): string {
    return ws.workspacePath
  }

  // Estimate width for a workspace cell (full path)
  function estimateWidth(ws: WorkspaceLike): number {
    // ~7px per character at 10px font + icon space + padding
    const statusIcon = ws.status !== "ready" ? 14 : 0
    return ws.workspacePath.length * 6.5 + statusIcon + 16
  }
</script>

{#snippet node({ item, position, width, height }: { item: WorkspaceLike; position: { col: number; row: number; x: number; y: number }; width: number; height: number })}
  {@const cfg = statusConfig(item.status)}
  {@const showStatusIcon = item.status !== "ready"}
  {@const isSelected = item.workspacePath === selectedPath}
  {@const padX = 6}
  
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <g
    class="workspace-cell"
    class:selected={isSelected}
    onclick={() => navigateTo(item)}
  >
    <!-- Background -->
    <rect
      {width}
      {height}
      rx="4"
      class="cell-bg"
      class:selected={isSelected}
    />

    <!-- Status icon (left side) -->
    {#if showStatusIcon}
      <text
        x={padX}
        y={height / 2 + 1}
        dominant-baseline="middle"
        class="status-icon {cfg.color}"
      >
        {cfg.icon}
      </text>
    {/if}

    <!-- Workspace name (full path) -->
    <text
      x={showStatusIcon ? padX + 14 : padX}
      y={height / 2 + 1}
      dominant-baseline="middle"
      class="workspace-name"
    >
      <title>{item.workspacePath}</title>
      {item.workspacePath}
    </text>
  </g>
{/snippet}

<DagLayout
  items={workspaces}
  {getId}
  {dependencyGraph}
  {estimateWidth}
  nodeHeight={24}
  nodeGapX={24}
  nodeGapY={8}
  minColumnWidth={60}
  horizontalFirst={true}
  {node}
/>

<style>
  .workspace-cell {
    cursor: pointer;
  }

  .cell-bg {
    fill: var(--color-surface-overlay);
    stroke: var(--color-border);
    stroke-width: 1;
    transition: stroke 0.15s ease, fill 0.15s ease;
  }

  .workspace-cell:hover .cell-bg {
    stroke: var(--color-yaffle-500);
    stroke-opacity: 0.6;
  }

  .cell-bg.selected {
    fill: color-mix(in srgb, var(--color-yaffle-500) 15%, transparent);
    stroke: var(--color-yaffle-500);
  }

  .workspace-name {
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    fill: var(--color-text);
  }

  .status-icon {
    font-family: var(--font-mono, monospace);
    font-size: 9px;
  }

  /* Status colors for SVG text fill */
  :global(.text-status-pending) {
    fill: var(--color-status-pending);
  }
  :global(.text-status-planning) {
    fill: var(--color-status-planning);
  }
  :global(.text-status-applying) {
    fill: var(--color-status-applying);
  }
  :global(.text-status-ready) {
    fill: var(--color-status-ready);
  }
  :global(.text-status-failed) {
    fill: var(--color-status-failed);
  }
  :global(.text-status-destroying) {
    fill: var(--color-status-destroying);
  }
  :global(.text-status-destroyed) {
    fill: var(--color-status-destroyed);
  }
</style>
