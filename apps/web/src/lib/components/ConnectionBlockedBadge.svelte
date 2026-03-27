<script lang="ts">
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"

  interface Props {
    org: string
    blockedCount: number
    providers: string[]
    canManageConnections: boolean
  }

  let { org, blockedCount, providers, canManageConnections }: Props = $props()

  const label = $derived(
    blockedCount === 1 ? "Missing Connection" : "Missing Connections",
  )

  const tooltip = $derived.by(() => {
    const baseText = `${blockedCount} workspace${blockedCount === 1 ? "" : "s"} blocked by missing connections`
    const providerText = providers.length > 0 ? `Missing: ${providers.join(", ")}` : "Missing providers are required before runs can proceed"

    if (canManageConnections) {
      return `${baseText}. ${providerText}. Click to open connection setup.`
    }

    return `${baseText}. ${providerText}. Contact your org admin to set up connections.`
  })

  async function handleClick(): Promise<void> {
    if (canManageConnections) {
      await goto(`${base}/${org}/settings/connections`)
      return
    }

    window.alert("Contact your org admin to set up connections.")
  }
</script>

<button
  class="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/15"
  title={tooltip}
  onclick={handleClick}
  type="button"
>
  <span class="font-mono">⚠</span>
  {label}
</button>
