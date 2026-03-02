<script lang="ts">
  import { browser } from "$app/environment"
  import { goto } from "$app/navigation"
  import { onMount, onDestroy } from "svelte"
  import { listOrgs } from "$lib/api"

  let hasToken = $state<boolean | null>(null)
  let redirecting = $state(false)
  let awaitingInstall = $state(false)
  let stream: EventSource | null = null

  const INSTALL_PENDING_KEY = "yaffle.installPending"

  function startInstall() {
    localStorage.setItem(INSTALL_PENDING_KEY, Date.now().toString())
    awaitingInstall = true
    window.open("https://github.com/apps/yaffle-dot-dev", "_blank")
  }

  function connectStream() {
    if (!browser || stream) return
    const token = localStorage.getItem("yaffle.accessToken")
    if (!token) return

    const params = new URLSearchParams()
    params.set("token", token)

    stream = new EventSource(`/api/orgs/stream?${params.toString()}`)
    stream.addEventListener("update", (event) => {
      if (redirecting) return
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { data: Array<{ login: string }> }
        if (payload.data.length > 0) {
          // Clear pending state
          localStorage.removeItem(INSTALL_PENDING_KEY)
          redirecting = true
          goto(`/${payload.data[0].login}`, { replaceState: true })
        }
      } catch {
        // ignore malformed payloads
      }
    })
    stream.addEventListener("error", () => {
      // Reconnect on error after a delay
      stream?.close()
      stream = null
      setTimeout(connectStream, 5000)
    })
  }

  // Listen for storage changes from other tabs
  function handleStorageChange(e: StorageEvent) {
    if (e.key === INSTALL_PENDING_KEY && e.newValue) {
      awaitingInstall = true
    }
  }

  onMount(async () => {
    if (!browser) return
    hasToken = Boolean(localStorage.getItem("yaffle.accessToken"))

    // Check if install is pending (user clicked install, possibly in another tab)
    const pendingTimestamp = localStorage.getItem(INSTALL_PENDING_KEY)
    if (pendingTimestamp) {
      // Only consider pending if within last 5 minutes
      const elapsed = Date.now() - parseInt(pendingTimestamp, 10)
      if (elapsed < 5 * 60 * 1000) {
        awaitingInstall = true
      } else {
        localStorage.removeItem(INSTALL_PENDING_KEY)
      }
    }

    window.addEventListener("storage", handleStorageChange)

    if (hasToken) {
      // Check once immediately
      redirecting = true
      try {
        const res = await listOrgs()
        if (res.data.length > 0) {
          localStorage.removeItem(INSTALL_PENDING_KEY)
          goto(`/${res.data[0].login}`, { replaceState: true })
          return
        }
      } catch {
        // If we can't fetch orgs, stay on landing page
      }
      redirecting = false

      // Connect to SSE stream to wait for org membership
      connectStream()
    }
  })

  onDestroy(() => {
    if (browser) {
      window.removeEventListener("storage", handleStorageChange)
    }
    if (stream) {
      stream.close()
      stream = null
    }
  })
</script>

{#if hasToken === null || redirecting}
  <!-- Checking auth state / redirecting -->
  <div class="min-h-[60vh]"></div>
{:else if !hasToken}
  <div class="min-h-[70vh] flex flex-col items-center justify-center text-center px-4">
    <div class="max-w-2xl space-y-8">
      <div class="space-y-4">
        <h1 class="text-4xl font-bold text-text tracking-tight">
          Preview infrastructure changes
          <span class="text-yaffle-400">before they hit production</span>
        </h1>
        <p class="text-lg text-text-muted max-w-xl mx-auto">
          Yaffle creates ephemeral Terraform workspaces for every pull request.
          See exactly what will change, get approvals, and merge with confidence.
        </p>
      </div>

      <div class="flex flex-col sm:flex-row gap-4 justify-center">
        <button
          onclick={() => import('$lib/auth').then(m => m.startGithubLogin())}
          class="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg
                 bg-yaffle-500 hover:bg-yaffle-400 text-white font-medium
                 transition-colors"
        >
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          Sign in with GitHub
        </button>
      </div>

      <div class="pt-8 grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
        <div class="space-y-2">
          <div class="text-yaffle-400 font-mono text-sm">01</div>
          <h3 class="font-semibold text-text">PR-triggered plans</h3>
          <p class="text-sm text-text-muted">
            Open a PR and Yaffle automatically runs terraform plan on your changes.
          </p>
        </div>
        <div class="space-y-2">
          <div class="text-yaffle-400 font-mono text-sm">02</div>
          <h3 class="font-semibold text-text">Isolated state</h3>
          <p class="text-sm text-text-muted">
            Each preview gets its own state file. No conflicts, no locks, no waiting.
          </p>
        </div>
        <div class="space-y-2">
          <div class="text-yaffle-400 font-mono text-sm">03</div>
          <h3 class="font-semibold text-text">Approval workflows</h3>
          <p class="text-sm text-text-muted">
            Require sign-off before applying. Integrates with your existing GitHub flow.
          </p>
        </div>
      </div>

      <p class="text-sm text-text-dim pt-4">
        Already have an account?
        <button
          onclick={() => import('$lib/auth').then(m => m.startGithubLogin())}
          class="text-yaffle-400 hover:underline"
        >
          Sign in
        </button>
      </p>
    </div>
  </div>
{:else}
  <!-- Signed in but no orgs - show onboarding message -->
  <div class="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
    <div class="max-w-md space-y-4">
      <h1 class="text-2xl font-semibold text-text">Welcome to Yaffle</h1>
      {#if awaitingInstall}
        <p class="text-text-muted">
          Waiting for GitHub App installation to complete...
        </p>
        <div class="flex items-center justify-center gap-3 text-text-muted">
          <svg class="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span class="text-sm">This will redirect automatically once complete</span>
        </div>
        <button
          onclick={() => { awaitingInstall = false; localStorage.removeItem(INSTALL_PENDING_KEY) }}
          class="text-sm text-text-dim hover:text-text-muted transition-colors"
        >
          Cancel
        </button>
      {:else}
        <p class="text-text-muted">
          Install the Yaffle GitHub App on an organization or your personal account to get started.
        </p>
        <button
          onclick={startInstall}
          class="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                 bg-yaffle-500 hover:bg-yaffle-400 text-white font-medium
                 transition-colors"
        >
          Install GitHub App
        </button>
      {/if}
    </div>
  </div>
{/if}
