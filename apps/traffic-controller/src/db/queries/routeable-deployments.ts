import { eq } from "drizzle-orm"

import { getDb, type TrafficControlDb } from "../client.ts"
import { routeableDeployments } from "../schema.ts"

export type RouteableDeployment = typeof routeableDeployments.$inferSelect

export interface UpsertRouteableDeploymentInput {
  externalDeploymentId: string
  prNumber: number
  environmentName: string
  environmentKind: string
  ownerGithubUserId: number
  ownerGithubLoginSnapshot: string
  receiverUrl: string
  receiverKind: RouteableDeployment["receiverKind"]
  state: RouteableDeployment["state"]
  hookdeckDestinationId?: string | null
  hookdeckDestinationName?: string | null
  lastReconciledAt?: Date | null
  lastSyncError?: string | null
}

function deploymentsDb(db?: TrafficControlDb): Promise<TrafficControlDb> | TrafficControlDb {
  return db ?? getDb()
}

export async function findRouteableDeploymentByExternalId(
  externalDeploymentId: string,
  db?: TrafficControlDb,
): Promise<RouteableDeployment | undefined> {
  const resolvedDb = await deploymentsDb(db)
  const rows = await resolvedDb
    .select()
    .from(routeableDeployments)
    .where(eq(routeableDeployments.externalDeploymentId, externalDeploymentId))
    .limit(1)

  return rows[0]
}

export async function findRouteableDeploymentById(
  id: string,
  db?: TrafficControlDb,
): Promise<RouteableDeployment | undefined> {
  const resolvedDb = await deploymentsDb(db)
  const rows = await resolvedDb
    .select()
    .from(routeableDeployments)
    .where(eq(routeableDeployments.id, id))
    .limit(1)

  return rows[0]
}

export async function upsertRouteableDeployment(
  input: UpsertRouteableDeploymentInput,
  db?: TrafficControlDb,
): Promise<RouteableDeployment> {
  const resolvedDb = await deploymentsDb(db)
  const now = new Date()
  const rows = await resolvedDb
    .insert(routeableDeployments)
    .values({
      externalDeploymentId: input.externalDeploymentId,
      prNumber: input.prNumber,
      environmentName: input.environmentName,
      environmentKind: input.environmentKind,
      ownerGithubUserId: input.ownerGithubUserId,
      ownerGithubLoginSnapshot: input.ownerGithubLoginSnapshot,
      receiverUrl: input.receiverUrl,
      receiverKind: input.receiverKind,
      hookdeckDestinationId: input.hookdeckDestinationId ?? null,
      hookdeckDestinationName: input.hookdeckDestinationName ?? null,
      lastReconciledAt: input.lastReconciledAt ?? null,
      lastSyncError: input.lastSyncError ?? null,
      state: input.state,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: routeableDeployments.externalDeploymentId,
      set: {
        prNumber: input.prNumber,
        environmentName: input.environmentName,
        environmentKind: input.environmentKind,
        ownerGithubUserId: input.ownerGithubUserId,
        ownerGithubLoginSnapshot: input.ownerGithubLoginSnapshot,
        receiverUrl: input.receiverUrl,
        receiverKind: input.receiverKind,
        hookdeckDestinationId: input.hookdeckDestinationId ?? null,
        hookdeckDestinationName: input.hookdeckDestinationName ?? null,
        lastReconciledAt: input.lastReconciledAt ?? null,
        lastSyncError: input.lastSyncError ?? null,
        state: input.state,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning()

  return rows[0]
}

export async function updateRouteableDeploymentHookdeckMetadata(
  id: string,
  params: {
    hookdeckDestinationId?: string | null
    hookdeckDestinationName?: string | null
    lastReconciledAt?: Date | null
    lastSyncError?: string | null
  },
  db?: TrafficControlDb,
): Promise<RouteableDeployment | undefined> {
  const resolvedDb = await deploymentsDb(db)
  const rows = await resolvedDb
    .update(routeableDeployments)
    .set({
      hookdeckDestinationId: params.hookdeckDestinationId,
      hookdeckDestinationName: params.hookdeckDestinationName,
      lastReconciledAt: params.lastReconciledAt,
      lastSyncError: params.lastSyncError,
      updatedAt: new Date(),
    })
    .where(eq(routeableDeployments.id, id))
    .returning()

  return rows[0]
}
