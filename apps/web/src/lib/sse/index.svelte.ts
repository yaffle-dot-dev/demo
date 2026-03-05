import { browser } from "$app/environment"

import { SSEConnection } from "./connection"
import { PreviewStreamStore, PreviewListStore } from "./stores.svelte"
import type { PreviewStreamState, PreviewListStreamState } from "./types"

// Re-export types consumers may need
export type {
  PreviewStreamState,
  PreviewListStreamState,
  ConnectionState,
  PreviewGroup,
} from "./types"
export { findRunInGroup, getLatestRunForWorkspace, hasActiveRun } from "./types"

// ---------------------------------------------------------------------------
// usePreviewStream - for PR and env detail pages
// ---------------------------------------------------------------------------

/**
 * Reactive SSE hook for PR and environment detail pages.
 *
 * Manages:
 * - EventSource lifecycle (connect, disconnect, reconnect with backoff)
 * - Visibility API (pause on tab hide, resume on show)
 * - Run-ID pinning (view a specific run while new ones arrive)
 * - Cleanup on unmount or param change
 *
 * Parameters are passed as getter functions so the `$effect` can track
 * reactive changes (e.g. when `$page.params` changes during navigation).
 *
 * Must be called during component initialization (in a `<script>` block).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   const org = $derived($page.params.org)
 *   const repo = $derived($page.params.repo)
 *   const prNumber = $derived(Number($page.params.prNumber))
 *
 *   const stream = usePreviewStream(() => org, () => repo, "pr", () => prNumber)
 * </script>
 * ```
 */
export function usePreviewStream(
  getOrg: () => string,
  getRepo: () => string,
  type: "pr" | "env",
  getId: () => string | number,
): PreviewStreamState {
  const store = new PreviewStreamStore()

  // $effect tracks the getter calls and re-runs when their values change.
  // The cleanup function tears down the old connection before creating a new one.
  $effect(() => {
    const org = getOrg()
    const repo = getRepo()
    const id = getId()

    if (!browser || !org || !repo || !id) return

    // Reset state for new connection
    store.reset()

    const path = type === "pr"
      ? `/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/pr/${id}/stream`
      : `/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/env/${encodeURIComponent(String(id))}/stream`

    const url = `/api${path}`

    const connection = new SSEConnection({
      url,
      withCredentials: true, // Send cookies for BetterAuth session
      onMessage: (data) => store.handleMessage(data),
      onStateChange: (state) => { store.connectionState = state },
      onError: (err) => console.error("[sse] parse error:", err),
    })

    connection.connect()

    // Cleanup: runs when effect re-runs (param change) or component unmounts
    return () => {
      connection.destroy()
    }
  })

  return {
    get data() { return store.data },
    get connectionState() { return store.connectionState },
    get isStreaming() { return store.isStreaming },
    get viewedRunId() { return store.viewedRunId },
    get hasNewerRun() { return store.hasNewerRun },
    get pinnedHeadSha() { return store.pinnedHeadSha },
    switchToLatest: () => store.switchToLatest(),
  }
}

// ---------------------------------------------------------------------------
// usePreviewListStream - for org dashboard page
// ---------------------------------------------------------------------------

/**
 * Reactive SSE hook for the org dashboard preview list.
 *
 * Must be called during component initialization (in a `<script>` block).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   const org = $derived($page.params.org)
 *   const stream = usePreviewListStream(() => org)
 * </script>
 * ```
 */
export function usePreviewListStream(
  getOrg: () => string,
): PreviewListStreamState {
  const store = new PreviewListStore()

  $effect(() => {
    const org = getOrg()

    if (!browser || !org) return

    store.reset()

    const url = `/api/previews/stream?org=${encodeURIComponent(org)}`

    const connection = new SSEConnection({
      url,
      withCredentials: true, // Send cookies for BetterAuth session
      onMessage: (data) => store.handleMessage(data),
      onStateChange: (state) => { store.connectionState = state },
      onError: (err) => console.error("[sse] parse error:", err),
    })

    connection.connect()

    return () => {
      connection.destroy()
    }
  })

  return {
    get previews() { return store.previews },
    get connectionState() { return store.connectionState },
  }
}
