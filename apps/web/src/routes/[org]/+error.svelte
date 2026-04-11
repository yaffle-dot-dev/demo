<script lang="ts">
  let { status, error } = $props()
</script>

<div class="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
  <div class="max-w-lg space-y-4">
    <div class="text-xs font-mono uppercase tracking-[0.3em] text-text-dim">Error {status}</div>
    <h1 class="text-3xl font-semibold text-text">Organization not found</h1>
    <p class="text-sm text-text-muted">
      {error?.message ?? "This organization does not exist or you do not have access to it."}
    </p>
    <a
      href="/app/"
      class="inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:bg-surface-overlay hover:text-text"
    >
      Back to Yaffle
    </a>
  </div>
</div>
