<script lang="ts">
  import { browser } from "$app/environment"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"
  import { listOrgs } from "$lib/api"
  import { useSession, getLastOrg } from "$lib/auth"

  let hasInitialized = false

  const session = useSession()

  onMount(() => {
    if (!browser) return

    const unsubscribe = session.subscribe(async (state) => {
      if (state.isPending) return
      if (hasInitialized) return
      hasInitialized = true

      if (!state.data?.user) {
        goto(`${base}/`, { replaceState: true })
        return
      }

      // GitHub App was just installed. Redirect back to the org the user
      // came from (if known), or to the home page to create/select an org.
      const lastOrg = getLastOrg()
      if (lastOrg) {
        // Redirect to the repos page so they can link repos from the new installation
        goto(`${base}/${lastOrg}/repos`, { replaceState: true })
        return
      }

      // No last org — check if user has any orgs
      try {
        const res = await listOrgs()
        if (res.data.length > 0) {
          goto(`${base}/${res.data[0].slug}/repos`, { replaceState: true })
          return
        }
      } catch {
        // Fall through to home
      }

      // No orgs — send to home to create one
      goto(`${base}/`, { replaceState: true })
    })

    return unsubscribe
  })
</script>

<div class="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
  <div class="max-w-md space-y-4">
    <p class="text-text-muted">Redirecting...</p>
  </div>
</div>
