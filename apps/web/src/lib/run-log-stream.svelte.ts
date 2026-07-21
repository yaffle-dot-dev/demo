import { browser } from "$app/environment"

import { getRunOutput } from "$lib/api"
import { appendRunViewCorrelation, type RunViewCorrelation } from "$lib/run-view-monitoring"
import type { StreamPayloadMeta } from "$lib/sse/types"

type RunLogConnectionState =
  | "idle"
  | "loading"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

export interface RunLogStreamState {
  readonly output: string
  readonly isStreaming: boolean
  readonly connectionState: RunLogConnectionState
  readonly error: string | null
  readonly latestMeta: StreamPayloadMeta | null
  readonly lastOutputAtMs: number | null
}

export function useRunLogStream(
  getRunId: () => string | null,
  getShouldStream: () => boolean,
  getRunViewSessionId?: () => string | null,
  getPageViewId?: () => string | null,
): RunLogStreamState {
  let output = $state("")
  let isStreaming = $state(false)
  let connectionState = $state<RunLogConnectionState>("idle")
  let error = $state<string | null>(null)
  let latestMeta = $state<StreamPayloadMeta | null>(null)
  let lastOutputAtMs = $state<number | null>(null)

  let currentRunId: string | null = null
  let currentShouldStream = false
  let currentRunViewSessionId: string | null = null
  let currentPageViewId: string | null = null
  let eventSource: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let visibilityHandler: (() => void) | null = null
  let backoffMs = INITIAL_BACKOFF_MS
  let finished = false
  let destroyed = false
  let loadVersion = 0

  const close = (): void => {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  }

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const scheduleReconnect = (): void => {
    if (destroyed || finished || !currentRunId || !currentShouldStream || document.hidden) {
      return
    }

    clearReconnectTimer()
    connectionState = "disconnected"

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!destroyed && !finished && currentRunId && currentShouldStream && !document.hidden) {
        openStream()
      }
    }, backoffMs)

    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  }

  const handleLogEvent = (event: MessageEvent): void => {
    try {
      const parsed = JSON.parse(event.data) as { message?: string; meta?: StreamPayloadMeta }
      latestMeta = parsed.meta ?? latestMeta
      if (parsed.message) {
        output += parsed.message
        lastOutputAtMs = performance.now()
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      connectionState = "error"
    }
  }

  const handleResetEvent = (event: MessageEvent): void => {
    try {
      const parsed = JSON.parse(event.data) as { output?: string; meta?: StreamPayloadMeta }
      latestMeta = parsed.meta ?? latestMeta
      output = parsed.output ?? ""
      lastOutputAtMs = performance.now()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      connectionState = "error"
    }
  }

  const openStream = (): void => {
    if (destroyed || finished || !currentRunId || !currentShouldStream || document.hidden) {
      return
    }

    const runId = currentRunId
    const correlation: RunViewCorrelation = {
      runViewSessionId: currentRunViewSessionId,
      pageViewId: currentPageViewId,
    }

    close()
    connectionState = "connecting"
    error = null

    const url = appendRunViewCorrelation(
      `/api/runs/${encodeURIComponent(runId)}/logs?offset=${output.length}`,
      correlation,
    )
    const es = new EventSource(url, { withCredentials: true })
    eventSource = es

    es.addEventListener("open", () => {
      if (eventSource !== es || destroyed || currentRunId !== runId) return
      backoffMs = INITIAL_BACKOFF_MS
      connectionState = "connected"
    })

    es.addEventListener("log", (event) => {
      if (eventSource !== es || destroyed || currentRunId !== runId) return
      handleLogEvent(event as MessageEvent)
    })

    es.addEventListener("reset", (event) => {
      if (eventSource !== es || destroyed || currentRunId !== runId) return
      handleResetEvent(event as MessageEvent)
    })

    es.addEventListener("heartbeat", (event) => {
      if (eventSource !== es || destroyed || currentRunId !== runId) return
      if (connectionState !== "connected") {
        connectionState = "connected"
      }

      try {
        const parsed = JSON.parse((event as MessageEvent).data) as { meta?: StreamPayloadMeta }
        latestMeta = parsed.meta ?? latestMeta
      } catch {
        // Heartbeat metadata is optional.
      }
    })

    es.addEventListener("done", () => {
      if (eventSource !== es || destroyed || currentRunId !== runId) return
      finished = true
      isStreaming = false
      connectionState = "disconnected"
      clearReconnectTimer()
      close()
    })

    es.addEventListener("error", () => {
      if (eventSource !== es || destroyed || currentRunId !== runId || finished) return
      close()
      scheduleReconnect()
    })
  }

  const loadOutput = async (
    runId: string,
    version: number,
    correlation: RunViewCorrelation,
  ): Promise<void> => {
    try {
      const nextOutput = await getRunOutput(runId, correlation)

      if (destroyed || version !== loadVersion || currentRunId !== runId) {
        return
      }

      output = nextOutput

      if (currentShouldStream) {
        openStream()
      } else {
        isStreaming = false
        connectionState = "disconnected"
      }
    } catch (err) {
      if (destroyed || version !== loadVersion || currentRunId !== runId) {
        return
      }

      error = err instanceof Error ? err.message : String(err)
      connectionState = "error"
    }
  }

  const resetToIdle = (): void => {
    loadVersion += 1
    currentRunId = null
    currentShouldStream = false
    currentRunViewSessionId = null
    currentPageViewId = null
    finished = false
    clearReconnectTimer()
    close()
    output = ""
    isStreaming = false
    connectionState = "idle"
    error = null
    latestMeta = null
    lastOutputAtMs = null
  }

  const setTarget = (
    runId: string | null,
    shouldStream: boolean,
    runViewSessionId: string | null,
    pageViewId: string | null,
  ): void => {
    if (!browser) {
      return
    }

    if (!runId) {
      resetToIdle()
      return
    }

    const runChanged = runId !== currentRunId
    const streamingChanged = shouldStream !== currentShouldStream
    const correlationChanged =
      runViewSessionId !== currentRunViewSessionId || pageViewId !== currentPageViewId

    if (!runChanged && !streamingChanged && !correlationChanged) {
      return
    }

    currentRunId = runId
    currentShouldStream = shouldStream
    currentRunViewSessionId = runViewSessionId
    currentPageViewId = pageViewId
    isStreaming = shouldStream
    error = null

    const correlation: RunViewCorrelation = {
      runViewSessionId,
      pageViewId,
    }

    if (runChanged) {
      loadVersion += 1
      finished = false
      backoffMs = INITIAL_BACKOFF_MS
      clearReconnectTimer()
      close()
      output = ""
      latestMeta = null
      lastOutputAtMs = null
      connectionState = "loading"
      void loadOutput(runId, loadVersion, correlation)
      return
    }

    if (finished) {
      isStreaming = false
      connectionState = "disconnected"
      return
    }

    if (shouldStream) {
      backoffMs = INITIAL_BACKOFF_MS
      openStream()
    } else {
      clearReconnectTimer()
      close()
      connectionState = "disconnected"
    }
  }

  $effect(() => {
    if (!browser) {
      return
    }

    destroyed = false
    visibilityHandler = () => {
      if (destroyed || finished || !currentRunId || !currentShouldStream) {
        return
      }

      if (document.hidden) {
        clearReconnectTimer()
        close()
        connectionState = "disconnected"
      } else {
        backoffMs = INITIAL_BACKOFF_MS
        openStream()
      }
    }

    document.addEventListener("visibilitychange", visibilityHandler)

    return () => {
      destroyed = true
      clearReconnectTimer()
      close()
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler)
      }
    }
  })

  $effect(() => {
    setTarget(
      getRunId(),
      getShouldStream(),
      getRunViewSessionId?.() ?? null,
      getPageViewId?.() ?? null,
    )
  })

  return {
    get output() {
      return output
    },
    get isStreaming() {
      return isStreaming
    },
    get connectionState() {
      return connectionState
    },
    get error() {
      return error
    },
    get latestMeta() {
      return latestMeta
    },
    get lastOutputAtMs() {
      return lastOutputAtMs
    },
  }
}
