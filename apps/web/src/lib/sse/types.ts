import type {
  PrPreviewGroup,
  EnvPreviewGroup,
  Preview,
  WorkspaceWithRuns,
  Run,
} from "$lib/api"

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState = "connecting" | "connected" | "disconnected"

// ---------------------------------------------------------------------------
// SSE message types (from backend)
// ---------------------------------------------------------------------------

/** Payload shape for PR/env detail SSE streams */
export interface PreviewStreamPayload {
  data: PrPreviewGroup | EnvPreviewGroup | null
}

/** Payload shape for org dashboard preview list SSE stream */
export interface PreviewListPayload {
  data: Preview[]
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Hook return types
// ---------------------------------------------------------------------------

/** Return type of usePreviewStream (PR and env detail pages) */
export interface PreviewStreamState {
  /** Live data from SSE - always the latest snapshot */
  readonly data: PrPreviewGroup | EnvPreviewGroup | null
  /** Connection lifecycle state */
  readonly connectionState: ConnectionState
  /** Whether a run is actively streaming (running or pending) */
  readonly isStreaming: boolean
  /** The run ID the user is currently viewing (null = latest) */
  readonly viewedRunId: string | null
  /** Whether a newer run exists beyond the pinned one */
  readonly hasNewerRun: boolean
  /** The headSha at the time auto-pin activated (null when not pinned) */
  readonly pinnedHeadSha: string | null
  /** Switch viewedRunId back to the latest run */
  switchToLatest: () => void
}

/** Return type of usePreviewListStream (org dashboard page) */
export interface PreviewListStreamState {
  /** List of previews from SSE */
  readonly previews: Preview[]
  /** Connection lifecycle state */
  readonly connectionState: ConnectionState
}

// ---------------------------------------------------------------------------
// Connection manager types
// ---------------------------------------------------------------------------

export interface SSEConnectionOptions {
  /** URL to connect to */
  url: string
  /** Whether to send credentials (cookies) with the request */
  withCredentials?: boolean
  /** Called with parsed data on each "update" event */
  onMessage: (data: unknown) => void
  /** Called when connection state changes */
  onStateChange: (state: ConnectionState) => void
  /** Called on unrecoverable parse errors */
  onError?: (error: Error) => void
}

// ---------------------------------------------------------------------------
// Helper types for run pinning
// ---------------------------------------------------------------------------

export type PreviewGroup = PrPreviewGroup | EnvPreviewGroup

/** Find a specific run by ID across all workspaces */
export function findRunInGroup(
  group: PreviewGroup,
  runId: string,
): { workspace: WorkspaceWithRuns; run: Run } | null {
  for (const ws of group.workspaces) {
    const run = ws.runs.find((r) => r.id === runId)
    if (run) return { workspace: ws, run }
  }
  return null
}

/** Get the latest run across all workspaces for a given workspace path */
export function getLatestRunForWorkspace(
  group: PreviewGroup,
  workspacePath: string,
): Run | null {
  const ws = group.workspaces.find(
    (w) => w.preview.workspacePath === workspacePath,
  )
  if (!ws || ws.runs.length === 0) return null
  return ws.runs[0] // Runs are already sorted desc by createdAt from backend
}

/** Check if any run is active (running or pending) */
export function hasActiveRun(group: PreviewGroup): boolean {
  return group.workspaces.some((ws) =>
    ws.runs.some((r) => r.status === "running" || r.status === "pending"),
  )
}

/**
 * Filter runs to the current cycle only.
 * A cycle starts with a plan - any apply older than the latest plan is stale.
 * Returns only runs from the current cycle.
 */
export function filterToCurrentCycle(runs: Run[]): Run[] {
  if (runs.length === 0) return []

  // Find the latest plan (runs are sorted desc by createdAt)
  const latestPlan = runs.find((r) => r.runType === "plan")
  if (!latestPlan) return runs // No plan, return all runs

  // Only include runs created at or after the latest plan
  return runs.filter((r) => r.createdAt >= latestPlan.createdAt)
}

/**
 * Filter workspaces' runs to current cycle only.
 * Use this for sidebar display when not pinned.
 */
export function filterWorkspacesToCurrentCycle(
  workspaces: WorkspaceWithRuns[],
): WorkspaceWithRuns[] {
  return workspaces.map((ws) => ({
    ...ws,
    runs: filterToCurrentCycle(ws.runs),
  }))
}
