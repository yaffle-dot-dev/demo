<script lang="ts">
  import "../app.css"
  import { browser } from "$app/environment"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"
  import { logout, startGithubLogin, useSession, setLastOrg, getLastOrg } from "$lib/auth"
  import { onOrgListChanged } from "$lib/org-list-events"
  import { listOrgs, type OrgInfo } from "$lib/api"

  let { children } = $props()
  let orgs = $state<OrgInfo[]>([])
  let showOrgMenu = $state(false)
  let showUserMenu = $state(false)
  let hasFetchedOrgs = false

  const createOrgUrl = `${base}/new`

  // BetterAuth session store
  const session = useSession()

  // Derive user info from session
  const isLoggedIn = $derived(!!$session.data?.user)
  const userLogin = $derived($session.data?.user?.name ?? "")

  // Get current org from URL if on an org page, otherwise use last visited org
  const currentOrg = $derived(page.params.org ?? getLastOrg() ?? "")
  
  // Get current org's role (admin check for settings)
  const currentOrgRole = $derived(orgs.find(o => o.slug === currentOrg)?.role ?? "")
  const isOrgAdmin = $derived(currentOrgRole === "admin")

  $effect(() => {
    if (!browser) return
    if (!page.params.org) return
    setLastOrg(page.params.org)
  })

  async function fetchOrgs(force = false): Promise<void> {
    if (hasFetchedOrgs && !force) return
    hasFetchedOrgs = true
    try {
      const res = await listOrgs()
      orgs = res.data
    } catch {
      orgs = []
    }
  }

  onMount(() => {
    if (!browser) return

    const stopOrgListListener = onOrgListChanged((nextOrgs) => {
      if (nextOrgs) {
        orgs = nextOrgs
        hasFetchedOrgs = true
        return
      }

      void fetchOrgs(true)
    })

    // Subscribe to session changes and fetch orgs when logged in
    const unsubscribe = session.subscribe((state) => {
      if (state.isPending) return
      if (state.data?.user && !hasFetchedOrgs) {
        fetchOrgs()
      }
    })

    return () => {
      stopOrgListListener()
      unsubscribe()
    }
  })

  function signOut() {
    logout()
  }

  function selectOrg(slug: string) {
    showOrgMenu = false
    setLastOrg(slug)
    goto(`${base}/${slug}`)
  }
</script>

<svelte:window onclick={() => { showOrgMenu = false; showUserMenu = false }} />

<div class="min-h-screen bg-surface">
  <nav class="border-b border-border bg-surface-raised">
    <div class="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between gap-6">
      <div class="flex items-center gap-3">
        <a href="{base}/" class="font-mono text-lg font-bold text-yaffle-400 tracking-tight">
          yaffle
        </a>
        {#if orgs.length > 0}
          <span class="text-text-dim">/</span>
          <div class="relative">
            <button
              class="flex items-center gap-1.5 px-2 py-1 rounded text-sm font-medium text-text hover:bg-surface-overlay transition-colors"
              onclick={(e) => { e.stopPropagation(); showOrgMenu = !showOrgMenu }}
            >
              {currentOrg || "Select org"}
              <svg class="w-3 h-3 text-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if showOrgMenu}
              <div class="absolute top-full left-0 mt-1 py-1 bg-surface-raised border border-border rounded-lg shadow-lg z-50 min-w-[160px]">
                {#each orgs as org (org.id)}
                  <button
                    class="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-overlay transition-colors {org.slug === currentOrg ? 'text-yaffle-400' : 'text-text-muted'}"
                    onclick={() => selectOrg(org.slug)}
                  >
                    {org.name}
                  </button>
                {/each}
                <hr class="my-1 border-border" />
                <a
                  href={createOrgUrl}
                  class="block w-full text-left px-3 py-1.5 text-sm text-text-dim hover:bg-surface-overlay hover:text-text transition-colors"
                >
                  + Add organization
                </a>
              </div>
            {/if}
          </div>
        {:else if isLoggedIn}
          <span class="text-text-dim">/</span>
          <a
            href={createOrgUrl}
            class="flex items-center gap-1.5 px-2 py-1 rounded text-sm font-medium text-text-muted hover:bg-surface-overlay hover:text-text transition-colors"
          >
            + Add organization
          </a>
        {/if}
      </div>
      <div class="flex gap-4 text-sm text-text-muted items-center">
        {#if isLoggedIn}
          <div class="relative">
            <button
              class="flex items-center gap-1.5 px-2 py-1 rounded text-sm text-text-dim hover:bg-surface-overlay hover:text-text transition-colors"
              onclick={(e) => { e.stopPropagation(); showUserMenu = !showUserMenu }}
            >
              @{userLogin}
              <svg class="w-3 h-3 text-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if showUserMenu}
              <div class="absolute top-full right-0 mt-1 py-1 bg-surface-raised border border-border rounded-lg shadow-lg z-50 min-w-[160px]">
                <a
                  href="{base}/settings"
                  class="block w-full text-left px-3 py-1.5 text-sm text-text-muted hover:bg-surface-overlay hover:text-text transition-colors"
                  onclick={() => showUserMenu = false}
                >
                  User settings
                </a>
                {#if currentOrg && isOrgAdmin}
                  <a
                    href="{base}/{currentOrg}/settings"
                    class="block w-full text-left px-3 py-1.5 text-sm text-text-muted hover:bg-surface-overlay hover:text-text transition-colors"
                    onclick={() => showUserMenu = false}
                  >
                    Org settings
                  </a>
                {/if}
                <hr class="my-1 border-border" />
                <button
                  class="block w-full text-left px-3 py-1.5 text-sm text-text-muted hover:bg-surface-overlay hover:text-text transition-colors"
                  onclick={signOut}
                >
                  Sign out
                </button>
              </div>
            {/if}
          </div>
        {:else}
          <button class="text-xs text-text-muted hover:text-text transition-colors" onclick={startGithubLogin}>
            Sign in with GitHub
          </button>
        {/if}
      </div>
    </div>
  </nav>

  <main class="mx-auto max-w-6xl px-4 py-6">
    {@render children()}
  </main>

  <!-- Build info -->
  <div class="fixed bottom-2 right-2 text-[10px] font-mono text-text-dim/50 select-all" title="Build: {__BUILD_SHA__} at {__BUILD_TIME__}">
    {__BUILD_SHA__}
  </div>
</div>
