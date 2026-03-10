// Standard icons:
// ✓ completed ok
// ✗ completed failure
// ~ pending / not started
// ... in progress
// - skipped (no changes)

export const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  pending: { label: "Pending", color: "text-status-pending", icon: "~" },
  planning: { label: "Planning", color: "text-status-planning", icon: "..." },
  planned: { label: "Planned", color: "text-status-ready", icon: "✓" },
  applying: { label: "Applying", color: "text-status-applying", icon: "..." },
  awaiting_approval: { label: "Awaiting approval", color: "text-status-planning", icon: "?" },
  ready: { label: "Ready", color: "text-status-ready", icon: "✓" },
  failed: { label: "Failed", color: "text-status-failed", icon: "✗" },
  destroying: { label: "Destroying", color: "text-status-destroying", icon: "..." },
  destroyed: { label: "Destroyed", color: "text-status-destroyed", icon: "✓" },
}

export function statusConfig(status: string): { label: string; color: string; icon: string } {
  return STATUS_CONFIG[status] ?? { label: status, color: "text-text-muted", icon: "?" }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "-"
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)

  if (diffSeconds < 60) return "just now"
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`
  return `${Math.floor(diffSeconds / 86400)}d ago`
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
