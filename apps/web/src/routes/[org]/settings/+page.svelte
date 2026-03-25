<script lang="ts">
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"

  onMount(() => {
    goto(`${base}/${page.params.org}/settings/members`, { replaceState: true })
  })
</script>
