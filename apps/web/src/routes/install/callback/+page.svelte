<script lang="ts">
  import { browser } from "$app/environment"
  import { goto } from "$app/navigation"
  import { onMount, onDestroy } from "svelte"
  import { listOrgs } from "$lib/api"
  import { useSession } from "$lib/auth"

  let status = $state<"loading" | "waiting" | "redirecting" | "error">("loading")
  let targetOrg = $state<string | null>(null)
  let pollInterval: ReturnType<typeof setInterval> | null = null
  let hasInitialized = false

  // BetterAuth session
  const session = useSession()

  onMount(() => {
    if (!browser) return

    // Subscribe to session changes
    const unsubscribe = session.subscribe(async (state) => {
      // Still loading session
      if (state.isPending) return

      // Only initialize once
      if (hasInitialized) return
      hasInitialized = true

      if (!state.data?.user) {
        // Not logged in - redirect to home to login first
        goto("/", { replaceState: true })
        return
      }

      // User is logged in - get current orgs to know what's "new"
      let knownOrgs = new Set<string>()
      try {
        const res = await listOrgs()
        knownOrgs = new Set(res.data.map(org => org.slug))
      } catch {
        // Continue anyway
      }

      status = "waiting"

      // Poll for the new org - webhook should create it shortly
      const checkForNewOrg = async () => {
        try {
          const res = await listOrgs()
          const newOrg = res.data.find(org => !knownOrgs.has(org.slug))
          if (newOrg) {
            status = "redirecting"
            targetOrg = newOrg.slug
            if (pollInterval) clearInterval(pollInterval)
            goto(`/${newOrg.slug}`, { replaceState: true })
          }
        } catch {
          // ignore
        }
      }

      // Check immediately, then poll every 2 seconds
      await checkForNewOrg()
      pollInterval = setInterval(checkForNewOrg, 2000)
    })

    return () => {
      unsubscribe()
      if (pollInterval) clearInterval(pollInterval)
    }
  })
</script>

<div class="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
  <div class="max-w-md space-y-4">
    {#if status === "loading"}
      <div class="flex items-center justify-center gap-3 text-text-muted">
        <svg class="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Loading...</span>
      </div>
    {:else if status === "waiting"}
      <h1 class="text-2xl font-semibold text-text">Setting up your organization</h1>
      <p class="text-text-muted">
        Waiting for GitHub App installation to complete...
      </p>
      <div class="flex items-center justify-center gap-3 text-text-muted">
        <svg class="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span class="text-sm">This usually takes a few seconds</span>
      </div>
    {:else if status === "redirecting"}
      <h1 class="text-2xl font-semibold text-text">Welcome!</h1>
      <p class="text-text-muted">
        Redirecting to <span class="font-mono text-yaffle-400">{targetOrg}</span>...
      </p>
    {:else if status === "error"}
      <h1 class="text-2xl font-semibold text-text">Something went wrong</h1>
      <p class="text-text-muted">
        Please try signing in again.
      </p>
      <a href="/" class="inline-block px-4 py-2 rounded-lg bg-yaffle-500 hover:bg-yaffle-400 text-white font-medium transition-colors">
        Go to home
      </a>
    {/if}
  </div>
</div>
