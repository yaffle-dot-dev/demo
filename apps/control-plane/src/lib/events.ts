import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"

import postgres from "postgres"

import type { EnvironmentKind } from "./config-toml.ts"
import { getDatabaseListenUrl, sql } from "./db.ts"
import { getSseEventsEmittedCounter, logger } from "./telemetry.ts"

export interface RunUpdateEvent {
  runId: string
  deploymentId: string
  emittedAt: string
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
  emittedAt: string
  /** @deprecated For backward compatibility with old listeners */
  previewId: string
}

export interface JobUpdateEvent {
  jobId: string
  deploymentId: string
  emittedAt: string
  /** @deprecated Use deploymentId */
  previewId: string
}

export interface EnvironmentGroupProjectionUpdateEvent {
  orgId: string
  repo: string
  environmentKind: EnvironmentKind
  environmentName: string
  emittedAt: string
}

type EventMap = {
  "run:update": RunUpdateEvent
  "deployment:update": DeploymentUpdateEvent
  "job:update": JobUpdateEvent
  "environment_group_projection:update": EnvironmentGroupProjectionUpdateEvent
}

type EventName = keyof EventMap

interface BroadcastEnvelope<T extends EventName = EventName> {
  senderId: string
  type: T
  payload: EventMap[T]
}

const PG_CHANNEL = "yaffle_control_plane_events"

class YaffleEvents {
  private readonly emitter = new EventEmitter()
  private readonly instanceId = randomUUID()
  private listenerReady: Promise<void> | null = null
  private listenerSql: ReturnType<typeof postgres> | null = null

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  emitRunUpdate(runId: string, deploymentId: string): void {
    getSseEventsEmittedCounter().add(1, { type: "run_update" })
    this.emit("run:update", {
      runId,
      deploymentId,
      emittedAt: new Date().toISOString(),
      previewId: deploymentId,
    })
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
    getSseEventsEmittedCounter().add(1, { type: "deployment_update" })

    this.emit("deployment:update", {
      deploymentId,
      orgId,
      repo,
      environmentKind,
      environmentName,
      emittedAt: new Date().toISOString(),
      previewId: deploymentId,
    })
  }

  emitJobUpdate(jobId: string, deploymentId: string): void {
    getSseEventsEmittedCounter().add(1, { type: "job_update" })
    this.emit("job:update", {
      jobId,
      deploymentId,
      emittedAt: new Date().toISOString(),
      previewId: deploymentId,
    })
  }

  emitEnvironmentGroupProjectionUpdate(
    orgId: string,
    repo: string,
    environmentKind: EnvironmentKind,
    environmentName: string,
  ): void {
    getSseEventsEmittedCounter().add(1, { type: "environment_group_projection_update" })
    this.emit("environment_group_projection:update", {
      orgId,
      repo,
      environmentKind,
      environmentName,
      emittedAt: new Date().toISOString(),
    })
  }

  onRunUpdate(handler: (event: RunUpdateEvent) => void): void {
    this.ensureListener()
    this.emitter.on("run:update", handler)
  }

  offRunUpdate(handler: (event: RunUpdateEvent) => void): void {
    this.emitter.off("run:update", handler)
  }

  onDeploymentUpdate(handler: (event: DeploymentUpdateEvent) => void): void {
    this.ensureListener()
    this.emitter.on("deployment:update", handler)
  }

  offDeploymentUpdate(handler: (event: DeploymentUpdateEvent) => void): void {
    this.emitter.off("deployment:update", handler)
  }

  onJobUpdate(handler: (event: JobUpdateEvent) => void): void {
    this.ensureListener()
    this.emitter.on("job:update", handler)
  }

  offJobUpdate(handler: (event: JobUpdateEvent) => void): void {
    this.emitter.off("job:update", handler)
  }

  onEnvironmentGroupProjectionUpdate(handler: (event: EnvironmentGroupProjectionUpdateEvent) => void): void {
    this.ensureListener()
    this.emitter.on("environment_group_projection:update", handler)
  }

  offEnvironmentGroupProjectionUpdate(handler: (event: EnvironmentGroupProjectionUpdateEvent) => void): void {
    this.emitter.off("environment_group_projection:update", handler)
  }

  private emit<T extends EventName>(type: T, payload: EventMap[T]): void {
    this.emitter.emit(type, payload)
    void this.broadcast(type, payload)
  }

  private ensureListener(): void {
    if (this.listenerReady) {
      return
    }

    this.listenerReady = this.startListener().catch((error) => {
      this.listenerReady = null
      logger.error("events.listener.failed", {
        channel: PG_CHANNEL,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private async startListener(): Promise<void> {
    const listenUrl = getDatabaseListenUrl()

    if (!process.env.DATABASE_LISTEN_URL) {
      const log = process.env.NODE_ENV === "production" ? logger.warn : logger.info
      log("events.listener.using_database_url", {
        channel: PG_CHANNEL,
        note: "Set DATABASE_LISTEN_URL to a direct Postgres connection when using PgBouncer transaction pooling.",
      })
    }

    this.listenerSql = postgres(listenUrl, {
      max: 1,
      idle_timeout: 0,
      connect_timeout: 10,
      connection: {
        application_name: "yaffle-events-listener",
      },
    })

    await this.listenerSql.listen(
      PG_CHANNEL,
      (payload) => this.handleBroadcast(payload),
      () => {
        logger.info("events.listener.ready", {
          channel: PG_CHANNEL,
          hasDedicatedListenUrl: !!process.env.DATABASE_LISTEN_URL,
        })
      },
    )
  }

  private async broadcast<T extends EventName>(
    type: T,
    payload: EventMap[T],
  ): Promise<void> {
    const envelope: BroadcastEnvelope<T> = {
      senderId: this.instanceId,
      type,
      payload,
    }

    try {
      await sql.notify(PG_CHANNEL, JSON.stringify(envelope))
    } catch (error) {
      logger.error("events.broadcast.failed", {
        channel: PG_CHANNEL,
        type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private handleBroadcast(payload: string): void {
    let parsed: BroadcastEnvelope | null = null

    try {
      parsed = JSON.parse(payload) as BroadcastEnvelope
    } catch (error) {
      logger.warn("events.broadcast.invalid_json", {
        channel: PG_CHANNEL,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    if (!parsed || parsed.senderId === this.instanceId) {
      return
    }

    switch (parsed.type) {
      case "run:update":
      case "deployment:update":
      case "job:update":
      case "environment_group_projection:update":
        this.emitter.emit(parsed.type, parsed.payload)
        return
      default:
        logger.warn("events.broadcast.unknown_type", {
          channel: PG_CHANNEL,
          type: String((parsed as { type?: unknown }).type ?? "unknown"),
        })
    }
  }
}

export const events = new YaffleEvents()
