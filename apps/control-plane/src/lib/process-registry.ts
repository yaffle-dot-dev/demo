import type { ChildProcess } from "node:child_process"

/**
 * Registry for tracking running terraform processes.
 * Allows graceful cancellation of runs by sending SIGINT.
 */
class ProcessRegistry {
  private processes = new Map<string, ChildProcess>()

  /**
   * Register a process for a run.
   */
  register(runId: string, proc: ChildProcess): void {
    this.processes.set(runId, proc)
  }

  /**
   * Unregister a process when it completes.
   */
  unregister(runId: string): void {
    this.processes.delete(runId)
  }

  /**
   * Cancel a run by sending SIGINT to its process.
   * Returns true if a process was found and signaled.
   */
  cancel(runId: string): boolean {
    const proc = this.processes.get(runId)
    if (!proc) {
      return false
    }

    // Send SIGINT for graceful shutdown (terraform will clean up)
    proc.kill("SIGINT")
    return true
  }

  /**
   * Check if a run has an active process.
   */
  isRunning(runId: string): boolean {
    return this.processes.has(runId)
  }
}

export const processRegistry = new ProcessRegistry()
