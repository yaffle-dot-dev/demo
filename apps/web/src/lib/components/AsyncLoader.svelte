<script lang="ts">
  interface Props {
    title?: string
    message?: string
    variant?: "inline" | "page"
  }

  let {
    title = "Loading",
    message = "This usually takes a moment.",
    variant = "inline",
  }: Props = $props()
</script>

{#if variant === "page"}
  <div class="flex min-h-[40vh] items-center justify-center px-4">
    <div class="w-full max-w-md rounded-xl border border-border bg-surface-raised px-4 py-4">
      <div class="flex items-start gap-3">
        <svg
          class="mt-0.5 h-4 w-4 animate-spin text-yaffle-400"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke-opacity="0.25"></circle>
          <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"></path>
        </svg>
        <div>
          <div class="text-sm font-medium text-text">{title}</div>
          <div class="mt-1 text-xs text-text-dim">{message}</div>
        </div>
      </div>
    </div>
  </div>
{:else}
  <div class="rounded-lg border border-border bg-surface px-4 py-3">
    <div class="flex items-start gap-3">
      <svg
        class="mt-0.5 h-4 w-4 animate-spin text-yaffle-400"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" stroke-opacity="0.25"></circle>
        <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"></path>
      </svg>
      <div>
        <div class="text-sm font-medium text-text">{title}</div>
        <div class="mt-1 text-xs text-text-dim">{message}</div>
      </div>
    </div>
  </div>
{/if}
