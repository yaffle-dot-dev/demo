import { browser } from "$app/environment"

export interface RunViewCorrelation {
  runViewSessionId: string | null
  pageViewId: string | null
}

export type RunViewTelemetryEventName =
  | "run_view_opened"
  | "run_view_first_dag_rendered"
  | "run_view_selected_workspace_rendered"
  | "run_view_no_data_flash"
  | "run_view_stale_status_flash"
  | "run_view_new_run_detected"
  | "run_view_new_run_handoff_rendered"
  | "run_view_env_snapshot_applied"
  | "run_view_env_stream_reconnected"
  | "run_view_log_stream_reconnected"
  | "run_view_terminal_first_log_byte"
  | "run_view_terminal_stall_started"
  | "run_view_terminal_stall_ended"
  | "run_view_long_task"

export interface RunViewTelemetryEvent {
  name: RunViewTelemetryEventName
  occurredAt?: string
  runGroupId?: string | null
  runId?: string | null
  workspacePath?: string | null
  runType?: string | null
  durationMs?: number
  workspaceCount?: number
  affectedWorkspaceCount?: number
  usedPlaceholderDag?: boolean
  selectionSource?: "initial" | "manual"
  surface?: "page" | "tab"
  streamType?: "environment" | "run_log"
  sourceEventType?: string | null
  sourceEventAt?: string | null
  sentAt?: string | null
  freshnessMs?: number
  transportMs?: number
  clientApplyMs?: number
  reconnectCount?: number
  stallThresholdMs?: number
  connectionState?: string | null
  isVisible?: boolean
}

export interface RunViewTelemetryContext {
  org: string
  repo: string
  environmentName: string
  correlation: RunViewCorrelation | null
}

const RUN_VIEW_SESSION_STORAGE_KEY = "yaffle:run-view-session-id"

function createId(): string {
  return crypto.randomUUID()
}

export function getOrCreateRunViewSessionId(): string | null {
  if (!browser) {
    return null
  }

  const existing = sessionStorage.getItem(RUN_VIEW_SESSION_STORAGE_KEY)
  if (existing) {
    return existing
  }

  const next = createId()
  sessionStorage.setItem(RUN_VIEW_SESSION_STORAGE_KEY, next)
  return next
}

export function createRunViewPageId(): string | null {
  if (!browser) {
    return null
  }

  return createId()
}

export function appendRunViewCorrelation(
  url: string,
  correlation: RunViewCorrelation | null | undefined,
): string {
  if (!correlation?.runViewSessionId && !correlation?.pageViewId) {
    return url
  }

  const parsed = new URL(url, browser ? window.location.origin : "https://yaffle.local")

  if (correlation.runViewSessionId) {
    parsed.searchParams.set("run_view_session_id", correlation.runViewSessionId)
  }

  if (correlation.pageViewId) {
    parsed.searchParams.set("page_view_id", correlation.pageViewId)
  }

  return `${parsed.pathname}${parsed.search}`
}

export function createRunViewTelemetryClient(
  getContext: () => RunViewTelemetryContext,
): (event: RunViewTelemetryEvent) => void {
  return (event) => {
    if (!browser) {
      return
    }

    const context = getContext()
    if (!context.org || !context.repo || !context.environmentName) {
      return
    }

    const payload = JSON.stringify({
      events: [
        {
          ...event,
          occurredAt: event.occurredAt ?? new Date().toISOString(),
          runViewSessionId: context.correlation?.runViewSessionId ?? null,
          pageViewId: context.correlation?.pageViewId ?? null,
        },
      ],
    })

    const url = `/api/orgs/${encodeURIComponent(context.org)}/repos/${encodeURIComponent(context.repo)}/environment/${encodeURIComponent(context.environmentName)}/telemetry`

    const blob = new Blob([payload], { type: "application/json" })
    if (navigator.sendBeacon(url, blob)) {
      return
    }

    void fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  }
}
