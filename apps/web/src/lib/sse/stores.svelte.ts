import type { Preview, PrPreviewGroup, EnvPreviewGroup } from "$lib/api"
import type {
  ConnectionState,
  PreviewGroup,
  PreviewStreamPayload,
  PreviewListPayload,
  OrgStatusPayload,
  OrgProvisioningStatus,
  StreamPayloadMeta,
} from "./types"
import { hasActiveRun, getLatestRunGroup, getCurrentRunGroup } from "./types"

// ---------------------------------------------------------------------------
// PreviewStreamStore - state for PR/env detail pages
// ---------------------------------------------------------------------------

/**
 * Reactive state store for a single preview group (PR or env detail page).
 * Implements run-group-based pinning for multi-workspace runs.
 */
export class PreviewStreamStore {
  data = $state<PreviewGroup | null>(null)
  latestMeta = $state<StreamPayloadMeta | null>(null)
  connectionState = $state<ConnectionState>("disconnected")
  /** The run group ID being viewed (null = latest) */
  viewedRunGroupId = $state<string | null>(null)
  /** The headSha at the time auto-pin activated (the SHA being viewed) */
  pinnedHeadSha = $state<string | null>(null)

  get isStreaming(): boolean {
    return this.data !== null && hasActiveRun(this.data)
  }

  get hasNewerRunGroup(): boolean {
    if (!this.viewedRunGroupId || !this.data) return false
    const latestRunGroup = getLatestRunGroup(this.data)
    if (!latestRunGroup) return false
    // There's a newer run group if the latest ID differs from our pinned one
    return latestRunGroup.id !== this.viewedRunGroupId
  }

  /**
   * Handle an SSE "update" message. Always updates liveData.
   * Auto-pins to the current run group when a new run group starts,
   * so the user keeps seeing what they had until they click "switch to latest".
   */
  handleMessage(payload: unknown): void {
    const typed = payload as PreviewStreamPayload

    this.latestMeta = typed.meta ?? null
    if (!typed.data) return

    // Auto-pin: if unpinned and we already have data, check if a new run group started
    if (!this.viewedRunGroupId && this.data) {
      const oldLatest = getLatestRunGroup(this.data)
      const newLatest = getLatestRunGroup(typed.data)

      // A new run group appeared that didn't exist before - pin to old one
      if (oldLatest && newLatest && newLatest.id !== oldLatest.id) {
        // Pin to the old run group so user keeps seeing it
        // Use the run group's headSha, not the preview's (which may have already updated)
        this.viewedRunGroupId = oldLatest.id
        this.pinnedHeadSha = oldLatest.headSha
      }
    }

    this.data = typed.data
  }

  /** Switch back to following the latest run group (unpin) */
  switchToLatest(): void {
    this.viewedRunGroupId = null
    this.pinnedHeadSha = null
  }

  /** Pin to a specific run group ID */
  pinToRunGroup(runGroupId: string): void {
    this.viewedRunGroupId = runGroupId
    // pinnedHeadSha is only set during auto-pin; manual pin doesn't change the SHA display
  }

  /** Reset all state (used when params change) */
  reset(): void {
    this.data = null
    this.latestMeta = null
    this.connectionState = "disconnected"
    this.viewedRunGroupId = null
    this.pinnedHeadSha = null
  }
}

// ---------------------------------------------------------------------------
// PreviewListStore - state for org dashboard page
// ---------------------------------------------------------------------------

import type { DependencyGraph } from "$lib/api"

/**
 * Reactive state store for the preview list (org dashboard).
 */
export class PreviewListStore {
  previews = $state<Preview[]>([])
  dependencyGraphs = $state<Record<string, DependencyGraph>>({})
  hasReceivedSnapshot = $state(false)
  connectionState = $state<ConnectionState>("disconnected")

  /** Handle an SSE "update" message */
  handleMessage(payload: unknown): void {
    const typed = payload as PreviewListPayload
    this.hasReceivedSnapshot = true
    if (Array.isArray(typed.data)) {
      this.previews = typed.data
    }
    if (typed.dependencyGraphs && typeof typed.dependencyGraphs === "object") {
      this.dependencyGraphs = typed.dependencyGraphs
    }
  }

  /** Reset all state */
  reset(): void {
    this.previews = []
    this.dependencyGraphs = {}
    this.hasReceivedSnapshot = false
    this.connectionState = "disconnected"
  }
}

// ---------------------------------------------------------------------------
// OrgStatusStore - state for org provisioning status
// ---------------------------------------------------------------------------

/**
 * Reactive state store for org provisioning status.
 */
export class OrgStatusStore {
  status = $state<OrgProvisioningStatus | null>(null)
  error = $state<string | null>(null)
  attempts = $state<number>(0)
  connectionState = $state<ConnectionState>("disconnected")

  /** Handle an SSE "update" message */
  handleMessage(payload: unknown): void {
    const typed = payload as OrgStatusPayload
    if (typed.data) {
      this.status = typed.data.provisioningStatus
      this.error = typed.data.provisioningError
      this.attempts = typed.data.provisioningAttempts
    }
  }

  /** Reset all state */
  reset(): void {
    this.status = null
    this.error = null
    this.attempts = 0
    this.connectionState = "disconnected"
  }
}
