<script lang="ts">
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"
  import { createOrg, getPrivateBetaAccess, type PrivateBetaAccess } from "$lib/api"
  import { notifyOrgListChanged } from "$lib/org-list-events"
  import { useSession } from "$lib/auth"

  const session = useSession()

  let name = $state("")
  let slug = $state("")
  let slugTouched = $state(false)
  let creating = $state(false)
  let error = $state<string | null>(null)
  let checkingAccess = $state(false)
  let privateBetaAccess = $state<PrivateBetaAccess | null>(null)
  let accessLoaded = $state(false)

  const derivedSlug = $derived(
    slugTouched
      ? slug
      : name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
  )

  async function handleSubmit(e: Event) {
    e.preventDefault()
    error = null

    if (privateBetaAccess?.invitesRequired && !privateBetaAccess.hasAccess) {
      error = "Yaffle is currently invite-only. Ask for a private beta invite before creating an organization."
      return
    }

    creating = true

    try {
      const res = await createOrg({
        name,
        slug: derivedSlug || undefined,
      })
      notifyOrgListChanged()
      goto(`${base}/${res.data.slug}/settings/repositories`)
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to create organization"
      creating = false
    }
  }

  async function loadPrivateBetaAccess() {
    checkingAccess = true

    try {
      const access = await getPrivateBetaAccess()
      privateBetaAccess = access.data
    } catch {
      privateBetaAccess = {
        invitesRequired: true,
        hasAccess: false,
        isOperator: false,
        accessReason: "not_invited",
        matchedBy: null,
        invite: null,
      }
    } finally {
      checkingAccess = false
      accessLoaded = true
    }
  }

  onMount(() => {
    if ($session.data?.user && !accessLoaded) {
      void loadPrivateBetaAccess()
    }
  })

  $effect(() => {
    if ($session.isPending || !$session.data?.user || accessLoaded || checkingAccess) return
    void loadPrivateBetaAccess()
  })
</script>

{#if $session.isPending || checkingAccess}
  <div class="min-h-[60vh]"></div>
{:else if !$session.data?.user}
  <div class="min-h-[60vh] flex items-center justify-center">
    <p class="text-text-muted">Sign in to create an organization.</p>
  </div>
{:else if privateBetaAccess?.invitesRequired && !privateBetaAccess.hasAccess}
  <div class="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
    <div class="w-full max-w-md space-y-4">
      <h1 class="text-2xl font-semibold text-text">Private beta is invite only</h1>
      <p class="text-text-muted text-sm">
        Your account is signed in, but it is not currently approved to create a Yaffle organization.
      </p>
      <a
        href={`${base}/`}
        class="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-text-muted hover:text-text hover:bg-surface-overlay transition-colors"
      >
        Back to Yaffle
      </a>
    </div>
  </div>
{:else}
  <div class="min-h-[60vh] flex flex-col items-center justify-center px-4">
    <div class="w-full max-w-md space-y-6">
      <div class="space-y-2">
        <h1 class="text-2xl font-semibold text-text">Create an organization</h1>
        <p class="text-text-muted text-sm">
          Organizations are isolated tenants with their own encryption keys, state, and access controls.
        </p>
      </div>

      <form onsubmit={handleSubmit} class="space-y-4">
        <div class="space-y-1.5">
          <label for="org-name" class="block text-sm font-medium text-text">Name</label>
          <input
            id="org-name"
            type="text"
            bind:value={name}
            required
            class="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text
                   focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
            placeholder="My Organization"
          />
        </div>

        <div class="space-y-1.5">
          <label for="org-slug" class="block text-sm font-medium text-text">URL slug</label>
          <div class="flex items-center gap-1.5 text-sm text-text-muted">
            <span>yaffle.dev/</span>
            <input
              id="org-slug"
              type="text"
              value={derivedSlug}
              oninput={(e) => {
                slugTouched = true
                slug = (e.target as HTMLInputElement).value
              }}
              required
              pattern="[a-z0-9-]+"
              class="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text
                     focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
              placeholder="my-organization"
            />
          </div>
        </div>

        {#if error}
          <div class="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
            {error}
          </div>
        {/if}

        <button
          type="submit"
          disabled={creating || !name || !derivedSlug}
          class="w-full px-4 py-2 rounded-lg bg-yaffle-500 hover:bg-yaffle-400
                 text-white font-medium transition-colors
                   disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? "Creating..." : "Create organization"}
        </button>
      </form>
    </div>
  </div>
{/if}
