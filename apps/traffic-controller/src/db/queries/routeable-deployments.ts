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
        state: input.state,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning()

  return rows[0]
}
