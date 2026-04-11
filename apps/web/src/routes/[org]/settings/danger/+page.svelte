<script lang="ts">
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { page } from "$app/state"
  import { clearLastOrg } from "$lib/auth"
  import { deleteOrg, listOrgs } from "$lib/api"
  import { notifyOrgListChanged } from "$lib/org-list-events"

  const org = $derived(page.params.org ?? "")

  let confirmSlug = $state("")
  let deleting = $state(false)
  let error = $state<string | null>(null)

  const canDelete = $derived(confirmSlug === org && !deleting)

  async function deleteCurrentOrg() {
    if (!org || confirmSlug !== org || deleting) return

    const confirmed = window.confirm(
      `Delete the ${org} organization? This removes org data, repo mappings, jobs, and memberships.`,
    )
    if (!confirmed) return

    deleting = true
    error = null

    try {
      await deleteOrg(org, { confirmSlug })

      clearLastOrg()

      const remainingOrgs = await listOrgs()
      notifyOrgListChanged(remainingOrgs.data)
      if (remainingOrgs.data.length > 0) {
        await goto(`${base}/${remainingOrgs.data[0].slug}`, { replaceState: true })
        return
      }

      await goto(`${base}/`, { replaceState: true })
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to delete organization"
      deleting = false
    }
  }
</script>

<section class="space-y-2 border-b border-border pb-6">
  <h2 class="text-2xl font-semibold text-text">Danger zone</h2>
  <p class="text-sm text-text-muted max-w-3xl">
    Permanently remove this organization from Yaffle so you can start over with a clean org state.
  </p>
</section>

<div class="rounded-xl border border-red-500/30 bg-red-500/5 p-5 space-y-4">
  <div class="space-y-2">
    <h3 class="text-lg font-semibold text-text">Delete this organization</h3>
    <p class="text-sm text-text-muted">
      This deletes org-scoped Yaffle data for <span class="font-mono text-text">{org}</span>,
      including memberships, repo mappings, queued jobs, previews, and workspace records.
    </p>
    <p class="text-sm text-text-muted">
      To confirm, type <span class="font-mono text-text">{org}</span> below.
    </p>
  </div>

  <label class="block space-y-2">
    <span class="text-sm font-medium text-text">Organization slug confirmation</span>
    <input
      bind:value={confirmSlug}
      placeholder={org}
      class="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none transition-colors focus:border-red-400"
    />
  </label>

  {#if error}
    <div class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
      {error}
    </div>
  {/if}

  <div class="flex items-center justify-between gap-4">
    <p class="text-xs text-text-dim">
      Use this only for reset/retry workflows until broader org lifecycle tooling exists.
    </p>
    <button
      onclick={deleteCurrentOrg}
      disabled={!canDelete}
      class="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {deleting ? "Deleting..." : "Delete organization"}
    </button>
  </div>
</div>
