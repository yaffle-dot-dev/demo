import type { SSEConnectionOptions } from "./types"

// ---------------------------------------------------------------------------
// Backoff configuration
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const BACKOFF_MULTIPLIER = 2

// ---------------------------------------------------------------------------
// SSEConnection - manages a single EventSource lifecycle
// ---------------------------------------------------------------------------

/**
 * Manages an EventSource connection with:
 * - Exponential backoff reconnect (1s, 2s, 4s, 8s, ... max 30s)
 * - Visibility API integration (disconnect on hide, reconnect on show)
 * - Proper cleanup on destroy
 */
export class SSEConnection {
  private es: EventSource | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = INITIAL_BACKOFF_MS
  private destroyed = false
  private visibilityHandler: (() => void) | null = null

  constructor(private readonly options: SSEConnectionOptions) {}

  /**
   * Start the connection and register visibility handlers.
   * Call this once after construction.
   */
  connect(): void {
    if (this.destroyed) return
    this.setupVisibilityHandler()
    this.open()
  }

  /**
   * Permanently tear down the connection. After calling destroy(),
   * the connection will not reconnect.
   */
  destroy(): void {
    this.destroyed = true
    this.clearReconnectTimer()
    this.close()
    this.teardownVisibilityHandler()
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private open(): void {
    if (this.destroyed) return
    this.close()

    this.options.onStateChange("connecting")

    const es = new EventSource(this.options.url, {
      withCredentials: this.options.withCredentials ?? false,
    })
    this.es = es

    es.addEventListener("open", () => {
      // Only handle if this is still the active connection
      if (this.es !== es || this.destroyed) return
      this.backoffMs = INITIAL_BACKOFF_MS
      this.options.onStateChange("connected")
    })

    es.addEventListener("update", (event) => {
      if (this.es !== es || this.destroyed) return
      try {
        const parsed: unknown = JSON.parse((event as MessageEvent).data)
        this.options.onMessage(parsed)
      } catch (err) {
        this.options.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        )
      }
    })

    // Also handle heartbeat events (just acknowledge, no action needed)
    es.addEventListener("heartbeat", () => {
      // Heartbeats keep the connection alive - no processing needed
    })

    es.addEventListener("error", () => {
      if (this.es !== es || this.destroyed) return
      this.close()
      this.options.onStateChange("disconnected")
      this.scheduleReconnect()
    })
  }

  private close(): void {
    if (this.es) {
      this.es.close()
      this.es = null
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    this.clearReconnectTimer()

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.destroyed && !document.hidden) {
        this.open()
      }
    }, this.backoffMs)

    // Increase backoff for next attempt
    this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setupVisibilityHandler(): void {
    if (typeof document === "undefined") return

    this.visibilityHandler = () => {
      if (this.destroyed) return

      if (document.hidden) {
        // Tab hidden - disconnect to save resources
        this.clearReconnectTimer()
        this.close()
        this.options.onStateChange("disconnected")
      } else {
        // Tab visible - reconnect immediately (reset backoff)
        this.backoffMs = INITIAL_BACKOFF_MS
        this.open()
      }
    }

    document.addEventListener("visibilitychange", this.visibilityHandler)
  }

  private teardownVisibilityHandler(): void {
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler)
      this.visibilityHandler = null
    }
  }
}
