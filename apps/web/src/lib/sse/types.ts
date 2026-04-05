import type {
  PrPreviewGroup,
  EnvPreviewGroup,
  Preview,
  WorkspaceWithRuns,
  Run,
  RunGroup,
  DependencyGraph,
} from "$lib/api"

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState = "connecting" | "connected" | "disconnected"

// ---------------------------------------------------------------------------
// SSE message types (from backend)
// ---------------------------------------------------------------------------

export interface StreamPayloadMeta {
  streamType: "environment" | "pr" | "env" | "run_log"
  streamId: string
  runViewSessionId: string | null
  pageViewId: string | null
  sourceEventType: string
  sourceEventAt: string
  sentAt: string
}

/** Payload shape for PR/env detail SSE streams */
export interface PreviewStreamPayload {
  data: PrPreviewGroup | EnvPreviewGroup | null
  meta?: StreamPayloadMeta
}

/** Payload shape for org dashboard preview list SSE stream */
export interface PreviewListPayload {
  data: Preview[]
  /** Dependency graphs keyed by "{repo}:{environmentName}" */
  dependencyGraphs: Record<string, DependencyGraph>
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Org status types
// ---------------------------------------------------------------------------

export type OrgProvisioningStatus = "pending" | "provisioning" | "active" | "failed"

/** Payload shape for org status SSE stream */
export interface OrgStatusPayload {
  data: {
    id: string
    slug: string
    name: string
    provisioningStatus: OrgProvisioningStatus
    provisioningError: string | null
    provisioningAttempts: number
  }
}

/** Return type of useOrgStatusStream */
export interface OrgStatusStreamState {
  /** Org provisioning status */
  readonly status: OrgProvisioningStatus | null
  /** Error message if provisioning failed */
  readonly error: string | null
  /** Number of provisioning attempts */
  readonly attempts: number
  /** Connection lifecycle state */
  readonly connectionState: ConnectionState
}

// ---------------------------------------------------------------------------
// Hook return types
// ---------------------------------------------------------------------------

/** Return type of usePreviewStream (PR and env detail pages) */
export interface PreviewStreamState {
  /** Live data from SSE - always the latest snapshot */
  readonly data: PrPreviewGroup | EnvPreviewGroup | null
  /** Metadata from the latest SSE payload */
  readonly latestMeta: StreamPayloadMeta | null
  /** Connection lifecycle state */
  readonly connectionState: ConnectionState
  /** Whether a run is actively streaming (running or pending) */
  readonly isStreaming: boolean
  /** The run group ID the user is currently viewing (null = latest) */
  readonly viewedRunGroupId: string | null
  /** Whether a newer run group exists beyond the pinned one */
  readonly hasNewerRunGroup: boolean
  /** The headSha at the time auto-pin activated (null when not pinned) */
  readonly pinnedHeadSha: string | null
  /** Switch viewedRunGroupId back to the latest run group */
  switchToLatest: () => void
}

/** Return type of usePreviewListStream (org dashboard page) */
export interface PreviewListStreamState {
  /** List of previews from SSE */
  readonly previews: Preview[]
  /** Dependency graphs keyed by "{repo}:{environmentName}" */
  readonly dependencyGraphs: Record<string, DependencyGraph>
  /** Whether at least one snapshot payload has been received */
  readonly hasReceivedSnapshot: boolean
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

// ---------------------------------------------------------------------------
// Run Group helpers
// ---------------------------------------------------------------------------

/**
 * Get the latest run group from a preview group.
 */
export function getLatestRunGroup(group: PreviewGroup): RunGroup | null {
  const runGroups = group.runGroups
  if (!runGroups || runGroups.length === 0) return null
  // Run groups are sorted desc by createdAt from backend
  return runGroups[0]
}

/**
 * Get the current/active run group (running or pending).
 * Returns the latest run group if it's active, otherwise null.
 */
export function getCurrentRunGroup(group: PreviewGroup): RunGroup | null {
  const latest = getLatestRunGroup(group)
  if (!latest) return null
  if (latest.status === "running" || latest.status === "pending") {
    return latest
  }
  return null
}

/**
 * Get the last completed run group (success, failed, or partial).
 */
export function getLastCompletedRunGroup(group: PreviewGroup): RunGroup | null {
  const runGroups = group.runGroups
  if (!runGroups || runGroups.length === 0) return null
  return runGroups.find((rg) =>
    rg.status === "success" || rg.status === "failed" || rg.status === "partial"
  ) ?? null
}

/**
 * Filter runs to those belonging to a specific run group.
 */
export function filterRunsByRunGroup(runs: Run[], runGroupId: string): Run[] {
  return runs.filter((r) => r.runGroupId === runGroupId)
}

/**
 * Filter workspaces' runs to a specific run group.
 */
export function filterWorkspacesByRunGroup(
  workspaces: WorkspaceWithRuns[],
  runGroupId: string,
): WorkspaceWithRuns[] {
  return workspaces.map((ws) => ({
    ...ws,
    runs: filterRunsByRunGroup(ws.runs, runGroupId),
  }))
}

/**
 * Get workspaces that have runs in a specific run group.
 */
export function getWorkspacesInRunGroup(
  workspaces: WorkspaceWithRuns[],
  runGroupId: string,
): WorkspaceWithRuns[] {
  return workspaces.filter((ws) =>
    ws.runs.some((r) => r.runGroupId === runGroupId)
  ).map((ws) => ({
    ...ws,
    runs: filterRunsByRunGroup(ws.runs, runGroupId),
  }))
}
