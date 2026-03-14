import { EventEmitter } from "node:events"

import { getSseEventsEmittedCounter } from "./telemetry.ts"
import type { EnvironmentKind } from "./config-toml.ts"

export interface RunUpdateEvent {
  runId: string
  deploymentId: string
  /** @deprecated Use deploymentId */
  previewId: string
}

/**
 * Event type with environment-based identification.
 */
export interface DeploymentUpdateEvent {
  deploymentId: string
  orgId: string
  repo: string
  environmentKind: EnvironmentKind
  environmentName: string
  /** @deprecated For backward compatibility with old listeners */
  previewId: string
}

export interface JobUpdateEvent {
  jobId: string
  deploymentId: string
  /** @deprecated Use deploymentId */
  previewId: string
}

class YaffleEvents extends EventEmitter {
  constructor() {
    super()
    // Allow many concurrent SSE connections before warning.
    // Each browser tab creates 1-2 listeners per event type.
    this.setMaxListeners(100)
  }

  emitRunUpdate(runId: string, deploymentId: string): void {
    console.log(`[events] emitRunUpdate: runId=${runId} deploymentId=${deploymentId} listeners=${this.listenerCount("run:update")}`)
    getSseEventsEmittedCounter().add(1, { type: "run_update" })
    this.emit("run:update", { runId, deploymentId, previewId: deploymentId })
  }

  /**
   * Emit deployment update event with environment-based identification.
   */
  emitDeploymentUpdate(
    deploymentId: string,
    orgId: string,
    repo: string,
    environmentKind: EnvironmentKind,
    environmentName: string,
  ): void {
    console.log(`[events] emitDeploymentUpdate: deploymentId=${deploymentId} env=${environmentName} listeners=${this.listenerCount("deployment:update")}`)
    getSseEventsEmittedCounter().add(1, { type: "deployment_update" })

    // Emit new event
    this.emit("deployment:update", {
      deploymentId,
      orgId,
      repo,
      environmentKind,
      environmentName,
      previewId: deploymentId, // backward compat
    } satisfies DeploymentUpdateEvent)

  }

  onRunUpdate(handler: (event: RunUpdateEvent) => void): void {
    this.on("run:update", handler)
    console.log(`[events] onRunUpdate: now have ${this.listenerCount("run:update")} listeners`)
  }

  offRunUpdate(handler: (event: RunUpdateEvent) => void): void {
    this.off("run:update", handler)
    console.log(`[events] offRunUpdate: now have ${this.listenerCount("run:update")} listeners`)
  }

  onDeploymentUpdate(handler: (event: DeploymentUpdateEvent) => void): void {
    this.on("deployment:update", handler)
    console.log(`[events] onDeploymentUpdate: now have ${this.listenerCount("deployment:update")} listeners`)
  }

  offDeploymentUpdate(handler: (event: DeploymentUpdateEvent) => void): void {
    this.off("deployment:update", handler)
    console.log(`[events] offDeploymentUpdate: now have ${this.listenerCount("deployment:update")} listeners`)
  }

  emitJobUpdate(jobId: string, deploymentId: string): void {
    console.log(`[events] emitJobUpdate: jobId=${jobId} deploymentId=${deploymentId} listeners=${this.listenerCount("job:update")}`)
    getSseEventsEmittedCounter().add(1, { type: "job_update" })
    this.emit("job:update", { jobId, deploymentId, previewId: deploymentId })
  }

  onJobUpdate(handler: (event: JobUpdateEvent) => void): void {
    this.on("job:update", handler)
  }

  offJobUpdate(handler: (event: JobUpdateEvent) => void): void {
    this.off("job:update", handler)
  }
}

export const events = new YaffleEvents()
