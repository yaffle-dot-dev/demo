import { browser } from "$app/environment"

import { getRunOutput } from "$lib/api"

type RunLogConnectionState = "idle" | "loading" | "connecting" | "connected" | "disconnected" | "error"

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

export interface RunLogStreamState {
  readonly output: string
  readonly isStreaming: boolean
  readonly connectionState: RunLogConnectionState
  readonly error: string | null
}

export function useRunLogStream(
  getRunId: () => string | null,
  getShouldStream: () => boolean,
): RunLogStreamState {
  let output = $state("")
  let isStreaming = $state(false)
  let connectionState = $state<RunLogConnectionState>("idle")
  let error = $state<string | null>(null)

  let currentRunId: string | null = null
  let currentShouldStream = false
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
      const parsed = JSON.parse(event.data) as { message?: string }
      if (parsed.message) {
        output += parsed.message
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      connectionState = "error"
    }
  }

  const handleResetEvent = (event: MessageEvent): void => {
    try {
      const parsed = JSON.parse(event.data) as { output?: string }
      output = parsed.output ?? ""
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

    close()
    connectionState = "connecting"
    error = null

    const url = `/api/runs/${encodeURIComponent(runId)}/logs?offset=${output.length}`
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

    es.addEventListener("heartbeat", () => {
      if (eventSource !== es || destroyed || currentRunId !== runId) return
      if (connectionState !== "connected") {
        connectionState = "connected"
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

  const loadOutput = async (runId: string, version: number): Promise<void> => {
    try {
      const nextOutput = await getRunOutput(runId)

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
    finished = false
    clearReconnectTimer()
    close()
    output = ""
    isStreaming = false
    connectionState = "idle"
    error = null
  }

  const setTarget = (runId: string | null, shouldStream: boolean): void => {
    if (!browser) {
      return
    }

    if (!runId) {
      resetToIdle()
      return
    }

    const runChanged = runId !== currentRunId
    const streamingChanged = shouldStream !== currentShouldStream

    if (!runChanged && !streamingChanged) {
      return
    }

    currentRunId = runId
    currentShouldStream = shouldStream
    isStreaming = shouldStream
    error = null

    if (runChanged) {
      loadVersion += 1
      finished = false
      backoffMs = INITIAL_BACKOFF_MS
      clearReconnectTimer()
      close()
      output = ""
      connectionState = "loading"
      void loadOutput(runId, loadVersion)
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
    setTarget(getRunId(), getShouldStream())
  })

  return {
    get output() { return output },
    get isStreaming() { return isStreaming },
    get connectionState() { return connectionState },
    get error() { return error },
  }
}
