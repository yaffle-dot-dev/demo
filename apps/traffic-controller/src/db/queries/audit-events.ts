import { getDb, type TrafficControlDb } from "../client.ts"
import { trafficControlAuditEvents } from "../schema.ts"

export type TrafficControlAuditEvent = typeof trafficControlAuditEvents.$inferSelect

export interface CreateTrafficControlAuditEventInput {
  operationId?: string
  routeableDeploymentId?: string
  liveWebhookLeaseId?: string
  eventType: string
  actorGithubUserId?: number
  actorGithubLoginSnapshot?: string
  details?: Record<string, unknown>
}

function auditDb(db?: TrafficControlDb): Promise<TrafficControlDb> | TrafficControlDb {
  return db ?? getDb()
}

export async function createTrafficControlAuditEvent(
  input: CreateTrafficControlAuditEventInput,
  db?: TrafficControlDb,
): Promise<TrafficControlAuditEvent> {
  const resolvedDb = await auditDb(db)
  const rows = await resolvedDb
    .insert(trafficControlAuditEvents)
    .values({
      operationId: input.operationId,
      routeableDeploymentId: input.routeableDeploymentId,
      liveWebhookLeaseId: input.liveWebhookLeaseId,
      eventType: input.eventType,
      actorGithubUserId: input.actorGithubUserId,
      actorGithubLoginSnapshot: input.actorGithubLoginSnapshot,
      details: input.details ?? {},
    })
    .returning()

  return rows[0]
}
