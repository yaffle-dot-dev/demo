import type { Preview, PrPreviewGroup, EnvPreviewGroup } from "$lib/api"
import type {
  ConnectionState,
  PreviewGroup,
  PreviewStreamPayload,
  PreviewListPayload,
} from "./types"
import { hasActiveRun } from "./types"

// ---------------------------------------------------------------------------
// PreviewStreamStore - state for PR/env detail pages
// ---------------------------------------------------------------------------

/**
 * Reactive state store for a single preview group (PR or env detail page).
 * Implements run-ID-based pinning instead of SHA-based pinning.
 */
export class PreviewStreamStore {
  data = $state<PreviewGroup | null>(null)
  connectionState = $state<ConnectionState>("disconnected")
  viewedRunId = $state<string | null>(null)
  /** The headSha at the time auto-pin activated (the SHA being viewed) */
  pinnedHeadSha = $state<string | null>(null)

  get isStreaming(): boolean {
    return this.data !== null && hasActiveRun(this.data)
  }

  get hasNewerRun(): boolean {
    if (!this.viewedRunId || !this.data) return false
    // Check if the latest run in any workspace differs from the pinned run
    for (const ws of this.data.workspaces) {
      if (ws.runs.length > 0 && ws.runs[0].id !== this.viewedRunId) {
        // Only report newer if the viewed run actually exists in the data
        const viewedExists = this.data.workspaces.some((w) =>
          w.runs.some((r) => r.id === this.viewedRunId),
        )
        if (viewedExists) return true
      }
    }
    return false
  }

  /**
   * Handle an SSE "update" message. Always updates liveData.
   * Auto-pins to the current latest plan when a new run cycle starts,
   * so the user keeps seeing what they had until they click "switch to latest".
   */
  handleMessage(payload: unknown): void {
    const typed = payload as PreviewStreamPayload
    if (!typed.data) return

    // Auto-pin: if unpinned and we already have data, check if a new run
    // cycle started (new plan appeared that wasn't there before)
    if (!this.viewedRunId && this.data) {
      for (const newWs of typed.data.workspaces) {
        const oldWs = this.data.workspaces.find(
          (w) => w.preview.workspacePath === newWs.preview.workspacePath,
        )
        if (!oldWs) continue

        const oldLatestPlan = oldWs.runs.find((r) => r.runType === "plan")
        const newLatestPlan = newWs.runs.find((r) => r.runType === "plan")

        // A new plan appeared that didn't exist before — new run cycle
        if (
          newLatestPlan &&
          oldLatestPlan &&
          newLatestPlan.id !== oldLatestPlan.id &&
          (oldLatestPlan.status === "success" || oldLatestPlan.status === "failed")
        ) {
          this.viewedRunId = oldLatestPlan.id
          this.pinnedHeadSha = this.data.headSha
          break
        }
      }
    }

    this.data = typed.data
  }

  /** Switch back to following the latest run (unpin) */
  switchToLatest(): void {
    this.viewedRunId = null
    this.pinnedHeadSha = null
  }

  /** Pin to a specific run ID */
  pinToRun(runId: string): void {
    this.viewedRunId = runId
    // pinnedHeadSha is only set during auto-pin; manual pin doesn't change the SHA display
  }

  /** Reset all state (used when params change) */
  reset(): void {
    this.data = null
    this.connectionState = "disconnected"
    this.viewedRunId = null
    this.pinnedHeadSha = null
  }
}

// ---------------------------------------------------------------------------
// PreviewListStore - state for org dashboard page
// ---------------------------------------------------------------------------

/**
 * Reactive state store for the preview list (org dashboard).
 */
export class PreviewListStore {
  previews = $state<Preview[]>([])
  connectionState = $state<ConnectionState>("disconnected")

  /** Handle an SSE "update" message */
  handleMessage(payload: unknown): void {
    const typed = payload as PreviewListPayload
    if (Array.isArray(typed.data)) {
      this.previews = typed.data
    }
  }

  /** Reset all state */
  reset(): void {
    this.previews = []
    this.connectionState = "disconnected"
  }
}
