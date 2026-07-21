import { and, eq } from "drizzle-orm"

import { getDb, type TrafficControlDb } from "../client.ts"
import { trafficControlOperations } from "../schema.ts"

export type TrafficControlOperation = typeof trafficControlOperations.$inferSelect

export interface CreateTrafficControlOperationInput {
  requestId: string
  operationType: TrafficControlOperation["operationType"]
  input: Record<string, unknown>
  actorGithubUserId?: number
  actorGithubLoginSnapshot?: string
  routeableDeploymentId?: string
  liveWebhookLeaseId?: string
  status?: TrafficControlOperation["status"]
}

function operationsDb(db?: TrafficControlDb): Promise<TrafficControlDb> | TrafficControlDb {
  return db ?? getDb()
}

export async function findOperationById(
  operationId: string,
  db?: TrafficControlDb,
): Promise<TrafficControlOperation | undefined> {
  const resolvedDb = await operationsDb(db)
  const rows = await resolvedDb
    .select()
    .from(trafficControlOperations)
    .where(eq(trafficControlOperations.id, operationId))
    .limit(1)

  return rows[0]
}

export async function findOperationByRequestId(
  requestId: string,
  db?: TrafficControlDb,
): Promise<TrafficControlOperation | undefined> {
  const resolvedDb = await operationsDb(db)
  const rows = await resolvedDb
    .select()
    .from(trafficControlOperations)
    .where(eq(trafficControlOperations.requestId, requestId))
    .limit(1)

  return rows[0]
}

export async function createTrafficControlOperation(
  input: CreateTrafficControlOperationInput,
  db?: TrafficControlDb,
): Promise<TrafficControlOperation> {
  const resolvedDb = await operationsDb(db)
  const rows = await resolvedDb
    .insert(trafficControlOperations)
    .values({
      requestId: input.requestId,
      operationType: input.operationType,
      status: input.status ?? "accepted",
      input: input.input,
      actorGithubUserId: input.actorGithubUserId,
      actorGithubLoginSnapshot: input.actorGithubLoginSnapshot,
      routeableDeploymentId: input.routeableDeploymentId,
      liveWebhookLeaseId: input.liveWebhookLeaseId,
    })
    .returning()

  return rows[0]
}

export async function updateTrafficControlOperation(
  operationId: string,
  changes: Partial<
    Pick<
      TrafficControlOperation,
      | "status"
      | "output"
      | "resultCode"
      | "resultMessage"
      | "routeableDeploymentId"
      | "liveWebhookLeaseId"
      | "completedAt"
    >
  >,
  db?: TrafficControlDb,
): Promise<TrafficControlOperation | undefined> {
  const resolvedDb = await operationsDb(db)
  const rows = await resolvedDb
    .update(trafficControlOperations)
    .set({
      ...changes,
      updatedAt: new Date(),
    })
    .where(eq(trafficControlOperations.id, operationId))
    .returning()

  return rows[0]
}

export async function markOperationRunning(
  operationId: string,
  db?: TrafficControlDb,
): Promise<TrafficControlOperation | undefined> {
  return updateTrafficControlOperation(operationId, { status: "running" }, db)
}

export async function markOperationSucceeded(
  operationId: string,
  params: {
    output?: Record<string, unknown>
    routeableDeploymentId?: string
    liveWebhookLeaseId?: string
  },
  db?: TrafficControlDb,
): Promise<TrafficControlOperation | undefined> {
  return updateTrafficControlOperation(
    operationId,
    {
      status: "succeeded",
      output: params.output,
      routeableDeploymentId: params.routeableDeploymentId,
      liveWebhookLeaseId: params.liveWebhookLeaseId,
      completedAt: new Date(),
    },
    db,
  )
}

export async function markOperationFailed(
  operationId: string,
  params: { resultCode: string; resultMessage: string },
  db?: TrafficControlDb,
): Promise<TrafficControlOperation | undefined> {
  return updateTrafficControlOperation(
    operationId,
    {
      status: "failed",
      resultCode: params.resultCode,
      resultMessage: params.resultMessage,
      completedAt: new Date(),
    },
    db,
  )
}

export async function findInFlightOperationByRequestIdAndType(
  requestId: string,
  operationType: TrafficControlOperation["operationType"],
  db?: TrafficControlDb,
): Promise<TrafficControlOperation | undefined> {
  const resolvedDb = await operationsDb(db)
  const rows = await resolvedDb
    .select()
    .from(trafficControlOperations)
    .where(
      and(
        eq(trafficControlOperations.requestId, requestId),
        eq(trafficControlOperations.operationType, operationType),
      ),
    )
    .limit(1)

  return rows[0]
}
