<script lang="ts">
  import "../app.css"
  import { browser } from "$app/environment"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { onMount } from "svelte"
  import { logout, startGithubLogin, getUserLogin, setLastOrg } from "$lib/auth"
  import { listOrgs, type OrgInfo } from "$lib/api"

  let { children } = $props()
  let userLogin = $state("")
  let orgs = $state<OrgInfo[]>([])
  let showOrgMenu = $state(false)

  // GitHub App name for installation URL
  const GITHUB_APP_NAME = "yaffle-dot-dev"
  // Use installations/new/permissions with state param to get redirected back properly
  const installUrl = `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`

  // Get current org from URL if on an org page
  const currentOrg = $derived(page.params.org ?? "")

  onMount(async () => {
    if (!browser) return
    userLogin = getUserLogin() ?? ""

    // Fetch orgs if logged in
    if (localStorage.getItem("yaffle.accessToken")) {
      try {
        const res = await listOrgs()
        orgs = res.data
      } catch {
        orgs = []
      }
    }
  })

  function signOut() {
    logout()
    userLogin = ""
    window.location.href = "/"
  }

  function selectOrg(login: string) {
    showOrgMenu = false
    setLastOrg(login)
    goto(`/${login}`)
  }
</script>

<svelte:window onclick={() => showOrgMenu = false} />

<div class="min-h-screen bg-surface">
  <nav class="border-b border-border bg-surface-raised">
    <div class="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between gap-6">
      <div class="flex items-center gap-3">
        <a href="/" class="font-mono text-lg font-bold text-yaffle-400 tracking-tight">
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
                    class="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-overlay transition-colors {org.login === currentOrg ? 'text-yaffle-400' : 'text-text-muted'}"
                    onclick={() => selectOrg(org.login)}
                  >
                    {org.login}
                  </button>
                {/each}
                <hr class="my-1 border-border" />
                <a
                  href={installUrl}
                  class="block w-full text-left px-3 py-1.5 text-sm text-text-dim hover:bg-surface-overlay hover:text-text transition-colors"
                >
                  + Add organization
                </a>
              </div>
            {/if}
          </div>
        {:else if userLogin}
          <span class="text-text-dim">/</span>
          <a
            href={installUrl}
            class="flex items-center gap-1.5 px-2 py-1 rounded text-sm font-medium text-text-muted hover:bg-surface-overlay hover:text-text transition-colors"
          >
            + Add organization
          </a>
        {/if}
      </div>
      <div class="flex gap-4 text-sm text-text-muted items-center">
        {#if userLogin}
          <span class="text-xs text-text-dim">@{userLogin}</span>
          <button class="text-xs text-text-muted hover:text-text transition-colors" onclick={signOut}>
            Sign out
          </button>
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
</div>
