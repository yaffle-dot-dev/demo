<script lang="ts">
  import { onMount } from "svelte"
  import { exchangeCode, storeUserInfo, getAccessToken } from "$lib/auth"

  let error = $state("")
  let status = $state("Completing sign-in...")

  onMount(async () => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const errorParam = params.get("error")
    const errorDescription = params.get("error_description")
    const installationId = params.get("installation_id")
    const setupAction = params.get("setup_action")

    // Handle GitHub App installation callback (not OAuth)
    // This happens after installing the app - just redirect to home
    if (setupAction === "install" && installationId) {
      status = "GitHub App installed! Redirecting..."
      // If user is already logged in, go to dashboard
      // Otherwise go to landing page to sign in
      const token = getAccessToken()
      if (token) {
        window.location.href = "/"
      } else {
        // Trigger login flow so they can use the app
        window.location.href = "/"
      }
      return
    }

    if (errorParam) {
      error = errorDescription ?? errorParam
      return
    }

    if (!code) {
      error = "Missing authorization code"
      return
    }

    try {
      status = "Exchanging authorization code..."
      await exchangeCode(code)

      status = "Fetching user info..."
      const token = getAccessToken()
      if (!token) {
        throw new Error("No access token after exchange")
      }

      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Failed to fetch user info: ${res.status} ${body}`)
      }

      const data = await res.json()
      if (!data?.data?.login || !data?.data?.userId) {
        throw new Error("Invalid user info response")
      }

      storeUserInfo(data.data.login, data.data.userId)
      window.location.href = "/"
    } catch (err) {
      console.error("Auth callback error:", err)
      error = err instanceof Error ? err.message : String(err)
    }
  })
</script>

<div class="text-sm text-text-muted p-4">
  {#if error}
    <div class="text-status-failed">
      <p class="font-medium">Sign-in failed</p>
      <p class="mt-1">{error}</p>
      <a href="/" class="mt-4 inline-block text-yaffle-400 hover:underline">Return home</a>
    </div>
  {:else}
    <p>{status}</p>
  {/if}
</div>
