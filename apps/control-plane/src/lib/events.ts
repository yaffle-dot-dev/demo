import { EventEmitter } from "node:events"

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

class YaffleEvents extends EventEmitter {
  constructor() {
    super()
    // Allow a reasonable number of concurrent SSE connections before warning
    this.setMaxListeners(50)
  }

  emitRunUpdate(runId: string, previewId: string): void {
    console.log(`[events] emitRunUpdate: runId=${runId} previewId=${previewId} listeners=${this.listenerCount("run:update")}`)
    this.emit("run:update", { runId, previewId })
  }

  emitPreviewUpdate(previewId: string, orgId: string, repo: string, prNumber: number): void {
    console.log(`[events] emitPreviewUpdate: previewId=${previewId} prNumber=${prNumber} listeners=${this.listenerCount("preview:update")}`)
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
}

export const events = new YaffleEvents()
