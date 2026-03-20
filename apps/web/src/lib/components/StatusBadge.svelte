<script lang="ts">
  import { statusConfig } from "$lib/status"

  interface Props {
    status: string
    label?: string
  }

  let { status, label }: Props = $props()

  const cfg = $derived(statusConfig(status))
</script>

<span class={`inline-flex items-center gap-1.5 rounded bg-surface-overlay px-2 py-0.5 text-xs font-medium ${cfg.color}`}>
  <span class="font-mono">{cfg.icon}</span>
  {label ?? cfg.label}
</span>
