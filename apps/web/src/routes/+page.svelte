<script lang="ts">
  import { browser } from "$app/environment"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"
  import { listOrgs } from "$lib/api"
  import { getLastOrg, useSession, startGithubLogin } from "$lib/auth"

  // State flags - use regular variables since we control all mutations
  let hasCheckedSession = false
  let hasCheckedOrgs = false
  let isRedirecting = false

  // Reactive state for UI
  let showLoading = $state(true)
  let showLanding = $state(false)
  let showNoOrgs = $state(false)

  const GITHUB_APP_NAME = "yaffle-dot-dev"
  const installUrl = `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`

  // BetterAuth session store
  const session = useSession()

  async function checkOrgsAndRedirect(): Promise<void> {
    if (hasCheckedOrgs || isRedirecting) return
    hasCheckedOrgs = true
    isRedirecting = true

    try {
      const res = await listOrgs()
      if (res.data.length > 0) {
        // Check for last visited org, otherwise use first available
        const lastOrg = getLastOrg()
        const targetOrg = lastOrg && res.data.some(o => o.slug === lastOrg)
          ? lastOrg
          : res.data[0].slug
        goto(`${base}/${targetOrg}`, { replaceState: true })
        return
      }
      // User is logged in but has no orgs
      showLoading = false
      showNoOrgs = true
    } catch {
      // If we can't fetch orgs, show the "no orgs" prompt
      showLoading = false
      showNoOrgs = true
    }
  }

  onMount(() => {
    if (!browser) return

    // Subscribe to session changes and handle auth state
    const unsubscribe = session.subscribe((state) => {
      // Still loading session
      if (state.isPending) return

      // Prevent multiple checks
      if (hasCheckedSession) return
      hasCheckedSession = true

      if (state.data?.user) {
        // User is logged in - check for orgs
        checkOrgsAndRedirect()
      } else {
        // User is not logged in - show landing page
        showLoading = false
        showLanding = true
      }
    })

    return unsubscribe
  })
</script>

{#if showLoading}
  <!-- Checking auth state / redirecting -->
  <div class="min-h-[60vh]"></div>
{:else if showLanding}
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
          onclick={startGithubLogin}
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
          onclick={startGithubLogin}
          class="text-yaffle-400 hover:underline"
        >
          Sign in
        </button>
      </p>
    </div>
  </div>
{:else if showNoOrgs}
  <!-- Signed in but no orgs - prompt to create one -->
  <div class="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
    <div class="max-w-md space-y-4">
      <h1 class="text-2xl font-semibold text-text">Welcome to Yaffle</h1>
      <p class="text-text-muted">
        Create an organization to get started. You'll be able to link GitHub repositories after setup.
      </p>
      <a
        href="{base}/new"
        class="inline-flex items-center gap-2 px-4 py-2 rounded-lg
               bg-yaffle-500 hover:bg-yaffle-400 text-white font-medium
               transition-colors"
      >
        Create an org
      </a>
    </div>
  </div>
{/if}
