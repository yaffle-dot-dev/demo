<script lang="ts">
  let { status, error } = $props()

  const isOrgError = $derived(
    typeof error?.message === "string" && error.message.toLowerCase().includes("organization"),
  )
</script>

<div class="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
  <div class="max-w-lg space-y-4">
    <div class="text-xs font-mono uppercase tracking-[0.3em] text-text-dim">Error {status}</div>
    <h1 class="text-3xl font-semibold text-text">
      {#if status === 404 && isOrgError}
        Organization not found
      {:else if status === 404}
        Page not found
      {:else}
        Something went wrong
      {/if}
    </h1>
    <p class="text-sm text-text-muted">
      {error?.message ?? "An unexpected error occurred."}
    </p>
    <a
      href="/app/"
      class="inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:bg-surface-overlay hover:text-text"
    >
      Back to Yaffle
    </a>
  </div>
</div>
