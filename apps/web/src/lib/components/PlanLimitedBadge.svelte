<script lang="ts">
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"

  interface Props {
    org: string
  }

  let { org }: Props = $props()
</script>

<button
  class="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium bg-orange-500/10 text-orange-400 hover:bg-orange-500/15 transition-colors"
  title="This deployment is paused because your free plan limit has been reached. Upgrade to continue."
  onclick={() => goto(`${base}/${org}/settings/billing`)}
  type="button"
>
  <span class="font-mono">↑</span>
  Upgrade to run
</button>
