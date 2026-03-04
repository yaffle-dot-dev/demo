<script lang="ts">
  import { browser } from "$app/environment"
  import { goto } from "$app/navigation"
  import { page } from "$app/state"
  import { onMount, onDestroy } from "svelte"
  import { listOrgs } from "$lib/api"

  let status = $state<"loading" | "waiting" | "redirecting" | "error">("loading")
  let targetOrg = $state<string | null>(null)
  let stream: EventSource | null = null

  // GitHub passes installation_id in the query params after install
  const installationId = $derived(page.url.searchParams.get("installation_id"))

  function connectStream(knownOrgs: Set<string>) {
    if (!browser || stream) return
    const token = localStorage.getItem("yaffle.accessToken")
    if (!token) {
      status = "error"
      return
    }

    const params = new URLSearchParams()
    params.set("token", token)

    stream = new EventSource(`/api/orgs/stream?${params.toString()}`)
    stream.addEventListener("update", (event) => {
      if (status === "redirecting") return
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { data: Array<{ login: string }> }
        // Find the NEW org that wasn't in our initial set
        const newOrg = payload.data.find(org => !knownOrgs.has(org.login))
        if (newOrg) {
          status = "redirecting"
          targetOrg = newOrg.login
          stream?.close()
          goto(`/${newOrg.login}`, { replaceState: true })
        }
      } catch {
        // ignore
      }
    })
    stream.addEventListener("error", () => {
      stream?.close()
      stream = null
      // Retry after delay
      setTimeout(() => connectStream(knownOrgs), 2000)
    })
  }

  onMount(async () => {
    if (!browser) return

    const token = localStorage.getItem("yaffle.accessToken")
    if (!token) {
      // Not logged in - redirect to home to login first
      goto("/", { replaceState: true })
      return
    }

    // Get current orgs to know what's "new"
    let knownOrgs = new Set<string>()
    try {
      const res = await listOrgs()
      knownOrgs = new Set(res.data.map(org => org.login))
    } catch {
      // Continue anyway
    }

    status = "waiting"
    
    // Poll for the new org - webhook should create it shortly
    connectStream(knownOrgs)

    // Also poll once immediately and a few times quickly
    // (webhook might have already fired before we got here)
    const checkForNewOrg = async () => {
      try {
        const res = await listOrgs()
        const newOrg = res.data.find(org => !knownOrgs.has(org.login))
        if (newOrg) {
          status = "redirecting"
          targetOrg = newOrg.login
          stream?.close()
          goto(`/${newOrg.login}`, { replaceState: true })
        }
      } catch {
        // ignore
      }
    }

    // Check immediately, then at 1s and 3s
    await checkForNewOrg()
    setTimeout(checkForNewOrg, 1000)
    setTimeout(checkForNewOrg, 3000)
  })

  onDestroy(() => {
    stream?.close()
    stream = null
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
