<script lang="ts">
  import { page } from "$app/state"

  const org = $derived(page.params.org)
</script>

<div class="space-y-8">
  <div>
    <h1 class="text-2xl font-bold text-text">Organization Settings</h1>
    <p class="text-text-muted mt-1">Manage settings for {org}</p>
  </div>

  <!-- Members Section -->
  <section class="space-y-4">
    <h2 class="text-lg font-semibold text-text">Members</h2>
    <div class="bg-surface-raised border border-border rounded-lg p-4">
      <p class="text-sm text-text-dim text-center py-4">
        Member management coming soon.
      </p>
    </div>
  </section>

  <!-- Danger Zone -->
  <section class="space-y-4">
    <h2 class="text-lg font-semibold text-red-400">Danger Zone</h2>
    <div class="bg-surface-raised border border-red-500/30 rounded-lg p-4">
      <p class="text-sm text-text-muted">
        Organization deletion and other destructive actions will be available here.
      </p>
    </div>
  </section>
</div>
