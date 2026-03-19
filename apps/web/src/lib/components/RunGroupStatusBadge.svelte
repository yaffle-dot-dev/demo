<script lang="ts">
  import { statusConfig } from "$lib/status"

  interface Props {
    /** Array of workspace status strings */
    statuses: string[]
  }

  let { statuses }: Props = $props()

  // Compute aggregate status for the run group as a whole
  // Run group statuses: pending, in_progress, success, failed, mixed
  const aggregateStatus = $derived.by((): string => {
    if (statuses.length === 0) return "pending"

    const statusSet = new Set(statuses)

    // Workspace statuses that indicate active work
    const activeStatuses = ["planning", "applying", "destroying"]
    const hasActive = activeStatuses.some((s) => statusSet.has(s))

    // Workspace statuses that indicate waiting (not yet started or waiting for something)
    const waitingStatuses = ["pending", "queued", "awaiting_approval"]
    const hasWaiting = waitingStatuses.some((s) => statusSet.has(s))

    // Terminal states
    const hasFailed = statusSet.has("failed")
    const hasSystemError = statusSet.has("system_error")
    const terminalSuccessStatuses = ["ready", "destroyed", "planned", "skipped"]
    const hasSuccess = terminalSuccessStatuses.some((s) => statusSet.has(s))

    // If any workspace is actively running, we're in progress
    if (hasActive) return "in_progress"

    // All done - determine outcome
    // System errors are retriable infrastructure issues, distinct from user failures
    if (hasSystemError) return "system_error"
    if (hasFailed && hasSuccess) return "mixed"
    if (hasFailed) return "failed"
    if (hasSuccess && !hasWaiting) return "success"

    // Has waiting workspaces but nothing active = pending
    return "pending"
  })

  const cfg = $derived(statusConfig(aggregateStatus))
</script>

{#if statuses.length > 0 && aggregateStatus !== "success"}
  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
    <span class="font-mono">{cfg.icon}</span>
    {cfg.label}
  </span>
{/if}
