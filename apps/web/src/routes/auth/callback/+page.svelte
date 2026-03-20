<script lang="ts">
  import { onMount } from "svelte"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import AsyncLoader from "$lib/components/AsyncLoader.svelte"

  let error = $state("")
  let status = $state("Completing sign-in...")

  onMount(() => {
    const params = new URLSearchParams(window.location.search)
    const errorParam = params.get("error")
    const errorDescription = params.get("error_description")

    // Handle OAuth errors from BetterAuth
    if (errorParam) {
      error = errorDescription ?? errorParam
      return
    }

    // BetterAuth handles the OAuth callback on the server at /api/auth/callback/github.
    // When we reach this page, the session cookie should already be set.
    // Just redirect to the homepage - it will handle session checking and org redirect.
    status = "Sign-in successful! Redirecting..."
    
    // Small delay for UX, then redirect
    setTimeout(() => {
      goto(`${base}/`, { replaceState: true })
    }, 300)
  })
</script>

<div class="min-h-[40vh] flex items-center justify-center">
  <div class="text-sm text-text-muted p-4">
    {#if error}
      <div class="text-status-failed text-center">
        <p class="font-medium">Sign-in failed</p>
        <p class="mt-1">{error}</p>
        <a href="{base}/" class="mt-4 inline-block text-yaffle-400 hover:underline">Return home</a>
      </div>
    {:else}
      <AsyncLoader
        title="Completing sign-in"
        message={status}
      />
    {/if}
  </div>
</div>
