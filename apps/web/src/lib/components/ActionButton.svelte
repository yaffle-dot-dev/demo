<script lang="ts">
  import type { Snippet } from "svelte"

  let {
    onclick,
    disabled = false,
    children,
  }: {
    onclick: () => void
    disabled?: boolean
    children: Snippet
  } = $props()
</script>

<button
  {onclick}
  {disabled}
  class="rounded-lg border border-border px-3 py-2 text-sm text-text transition
         hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed"
>
  {@render children()}
</button>
