<script lang="ts">
  /**
   * MiniDagCell - Compact SVG cell for DAG visualization in the dashboard.
   * Shows workspace name + status icon in a minimal footprint.
   *
   * This is rendered inside an SVG <g> element via DagLayout's snippet system.
   */
  import type { Preview } from "$lib/api"
  import { statusConfig } from "$lib/status"

  interface Props {
    /** The workspace preview data */
    workspace: Preview
    /** Width of the cell in pixels */
    width: number
    /** Height of the cell in pixels */
    height: number
    /** Whether this cell is currently selected */
    selected?: boolean
    /** Click handler */
    onclick?: () => void
  }

  let {
    workspace,
    width,
    height,
    selected = false,
    onclick,
  }: Props = $props()

  const cfg = $derived(statusConfig(workspace.status))
  const showStatusIcon = $derived(workspace.status !== "ready")

  // Extract just the workspace name (last segment of path)
  const workspaceName = $derived(workspace.workspacePath.split("/").pop() ?? workspace.workspacePath)

  // Padding
  const padX = 6
  const padY = 4
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<g
  class="mini-cell"
  class:selected
  onclick={onclick}
>
  <!-- Background -->
  <rect
    {width}
    {height}
    rx="4"
    class="cell-bg"
    class:selected
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

  <!-- Workspace name -->
  <text
    x={showStatusIcon ? padX + 14 : padX}
    y={height / 2 + 1}
    dominant-baseline="middle"
    class="workspace-name"
  >
    <title>{workspace.workspacePath}</title>
    {workspaceName}
  </text>
</g>

<style>
  .mini-cell {
    cursor: pointer;
  }

  .cell-bg {
    fill: var(--color-surface-overlay);
    stroke: var(--color-border);
    stroke-width: 1;
    transition: stroke 0.15s ease, fill 0.15s ease;
  }

  .mini-cell:hover .cell-bg {
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
