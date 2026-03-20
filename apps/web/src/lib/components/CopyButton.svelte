<script lang="ts">
  interface Props {
    copied?: boolean
    title?: string
    onclick: () => void | Promise<void>
  }

  let { copied = false, title = "Copy", onclick }: Props = $props()
</script>

<button
  type="button"
  class="shrink-0 text-text-dim hover:text-text transition-colors p-1.5 rounded hover:bg-surface-overlay"
  {title}
  {onclick}
>
  {#if copied}
    <svg class="w-4 h-4 text-status-ready" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  {:else}
    <svg class="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="5" y="5" width="8" height="10" rx="1"/>
      <path d="M3 11V3a1 1 0 0 1 1-1h6"/>
    </svg>
  {/if}
</button>
