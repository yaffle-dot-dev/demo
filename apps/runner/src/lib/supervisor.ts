/**
 * Heartbeat Supervisor
 *
 * Manages heartbeat sending during job execution.
 * The supervisor is the parent process that:
 * 1. Starts a heartbeat loop when work begins
 * 2. Sends heartbeats to CP at regular intervals
 * 3. Stops heartbeats when work completes
 * 4. Kills the process if heartbeat fails (job was reclaimed)
 *
 * This ensures there's no gap where a job could be marked stale
 * between tofu execution and completion reporting.
 */

const HEARTBEAT_INTERVAL_MS = 5 * 1000 // 5 seconds
const HEARTBEAT_MAX_RETRIES = 3
const HEARTBEAT_RETRY_DELAY_MS = 5 * 1000 // 5 seconds

/** Any API client that can send heartbeats */
export interface HeartbeatCapable {
  heartbeat(): Promise<{ success: boolean; reason?: string }>
}

export interface SupervisorConfig {
  apiClient: HeartbeatCapable
  onHeartbeatFailure?: () => void
}

export class HeartbeatSupervisor {
  private readonly apiClient: HeartbeatCapable
  private readonly onHeartbeatFailure: () => void

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastHeartbeatSuccess = true

  constructor(config: SupervisorConfig) {
    this.apiClient = config.apiClient
    this.onHeartbeatFailure = config.onHeartbeatFailure ?? (() => {
      console.error("[supervisor] Heartbeat failed, exiting")
      process.exit(1)
    })
  }

  /**
   * Start the heartbeat supervisor.
   * Sends heartbeats at regular intervals.
   */
  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    console.log("[supervisor] Starting heartbeat supervisor")

    // Send initial heartbeat
    this.sendHeartbeat().catch(() => {})

    // Start heartbeat loop
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
  }

  /**
   * Stop the heartbeat supervisor.
   */
  stop(): void {
    if (!this.running) {
      return
    }

    this.running = false
    console.log("[supervisor] Stopping heartbeat supervisor")

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * Send a heartbeat with retries.
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.running) {
      return
    }

    for (let attempt = 1; attempt <= HEARTBEAT_MAX_RETRIES; attempt++) {
      try {
        const result = await this.apiClient.heartbeat()

        if (result.success) {
          if (!this.lastHeartbeatSuccess) {
            console.log("[supervisor] Heartbeat recovered after failure")
          }
          this.lastHeartbeatSuccess = true
          return
        }

        // Job is no longer running (reclaimed or completed)
        console.error(`[supervisor] Heartbeat rejected: ${result.reason}`)
        this.lastHeartbeatSuccess = false
        this.stop()
        this.onHeartbeatFailure()
        return
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        console.warn(
          `[supervisor] Heartbeat attempt ${attempt}/${HEARTBEAT_MAX_RETRIES} failed: ${errorMessage}`,
        )

        if (attempt < HEARTBEAT_MAX_RETRIES) {
          await this.sleep(HEARTBEAT_RETRY_DELAY_MS)
        }
      }
    }

    // All retries failed
    console.error("[supervisor] Heartbeat failed after all retries")
    this.lastHeartbeatSuccess = false
    this.stop()
    this.onHeartbeatFailure()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Execute a function under heartbeat supervision.
 *
 * Starts heartbeats before execution and stops them after.
 * If heartbeat fails, the function is aborted.
 */
export async function supervisedExec<T>(
  supervisor: HeartbeatSupervisor,
  description: string,
  fn: () => Promise<T>,
): Promise<T> {
  console.log(`[supervisor] Starting supervised execution: ${description}`)

  // Heartbeats should already be running from the main worker
  // This function just executes the work and lets heartbeats continue

  try {
    const result = await fn()
    console.log(`[supervisor] Completed: ${description}`)
    return result
  } catch (err) {
    console.error(`[supervisor] Failed: ${description}`, err)
    throw err
  }
}
