import { EventEmitter } from "node:events"

import { getSseEventsEmittedCounter } from "./telemetry.ts"

export interface RunUpdateEvent {
  runId: string
  previewId: string
}

export interface PreviewUpdateEvent {
  previewId: string
  orgId: string
  repo: string
  prNumber: number
}

export interface JobUpdateEvent {
  jobId: string
  previewId: string
}

class YaffleEvents extends EventEmitter {
  constructor() {
    super()
    // Allow many concurrent SSE connections before warning.
    // Each browser tab creates 1-2 listeners per event type.
    this.setMaxListeners(100)
  }

  emitRunUpdate(runId: string, previewId: string): void {
    console.log(`[events] emitRunUpdate: runId=${runId} previewId=${previewId} listeners=${this.listenerCount("run:update")}`)
    getSseEventsEmittedCounter().add(1, { type: "run_update" })
    this.emit("run:update", { runId, previewId })
  }

  emitPreviewUpdate(previewId: string, orgId: string, repo: string, prNumber: number): void {
    console.log(`[events] emitPreviewUpdate: previewId=${previewId} prNumber=${prNumber} listeners=${this.listenerCount("preview:update")}`)
    getSseEventsEmittedCounter().add(1, { type: "preview_update" })
    this.emit("preview:update", { previewId, orgId, repo, prNumber })
  }

  onRunUpdate(handler: (event: RunUpdateEvent) => void): void {
    this.on("run:update", handler)
    console.log(`[events] onRunUpdate: now have ${this.listenerCount("run:update")} listeners`)
  }

  offRunUpdate(handler: (event: RunUpdateEvent) => void): void {
    this.off("run:update", handler)
    console.log(`[events] offRunUpdate: now have ${this.listenerCount("run:update")} listeners`)
  }

  onPreviewUpdate(handler: (event: PreviewUpdateEvent) => void): void {
    this.on("preview:update", handler)
  }

  offPreviewUpdate(handler: (event: PreviewUpdateEvent) => void): void {
    this.off("preview:update", handler)
    console.log(`[events] offPreviewUpdate: now have ${this.listenerCount("preview:update")} listeners`)
  }

  emitJobUpdate(jobId: string, previewId: string): void {
    console.log(`[events] emitJobUpdate: jobId=${jobId} previewId=${previewId} listeners=${this.listenerCount("job:update")}`)
    getSseEventsEmittedCounter().add(1, { type: "job_update" })
    this.emit("job:update", { jobId, previewId })
  }

  onJobUpdate(handler: (event: JobUpdateEvent) => void): void {
    this.on("job:update", handler)
  }

  offJobUpdate(handler: (event: JobUpdateEvent) => void): void {
    this.off("job:update", handler)
  }
}

export const events = new YaffleEvents()
