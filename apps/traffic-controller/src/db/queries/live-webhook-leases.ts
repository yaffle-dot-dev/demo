import { and, eq, isNull } from "drizzle-orm"

import { getDb, type TrafficControlDb } from "../client.ts"
import { liveWebhookLeases, routeableDeployments } from "../schema.ts"

export type LiveWebhookLease = typeof liveWebhookLeases.$inferSelect

export interface LiveWebhookLeaseWithDeployment extends LiveWebhookLease {
  routeableDeployment: typeof routeableDeployments.$inferSelect
}

export interface CreateLiveWebhookLeaseInput {
  prNumber: number
  routeableDeploymentId: string
  actorGithubUserId: number
  actorGithubLoginSnapshot: string
  scopeClass: LiveWebhookLease["scopeClass"]
  event: LiveWebhookLease["event"]
  installationId: number
  repositoryId?: number | null
  action?: string | null
  pullRequestNumber?: number | null
  ref?: string | null
  githubOwnerTypeSnapshot: string
  githubOwnerIdSnapshot: number
  githubOwnerLoginSnapshot: string
  reason: string
}

export interface UpdateLiveWebhookLeaseParams {
  status?: LiveWebhookLease["status"]
  hookdeckDestinationId?: string | null
  hookdeckDestinationName?: string | null
  hookdeckConnectionId?: string | null
  hookdeckConnectionName?: string | null
  lastReconciledAt?: Date | null
  lastSyncError?: string | null
  activatedAt?: Date | null
  revokedAt?: Date | null
}

function leasesDb(db?: TrafficControlDb): Promise<TrafficControlDb> | TrafficControlDb {
  return db ?? getDb()
}

function maybeEq<T>(column: any, value: T | null | undefined) {
  return value == null ? isNull(column) : eq(column, value)
}

export async function findLiveWebhookLeaseById(
  id: string,
  db?: TrafficControlDb,
): Promise<LiveWebhookLease | undefined> {
  const resolvedDb = await leasesDb(db)
  const rows = await resolvedDb
    .select()
    .from(liveWebhookLeases)
    .where(eq(liveWebhookLeases.id, id))
    .limit(1)

  return rows[0]
}

export async function findLiveWebhookLeaseWithDeploymentById(
  id: string,
  db?: TrafficControlDb,
): Promise<LiveWebhookLeaseWithDeployment | undefined> {
  const resolvedDb = await leasesDb(db)
  const rows = await resolvedDb
    .select({
      lease: liveWebhookLeases,
      routeableDeployment: routeableDeployments,
    })
    .from(liveWebhookLeases)
    .innerJoin(routeableDeployments, eq(routeableDeployments.id, liveWebhookLeases.routeableDeploymentId))
    .where(eq(liveWebhookLeases.id, id))
    .limit(1)

  return rows[0] ? { ...rows[0].lease, routeableDeployment: rows[0].routeableDeployment } : undefined
}

export async function findLiveWebhookLeaseByExactScope(params: {
  routeableDeploymentId: string
  event: LiveWebhookLease["event"]
  installationId: number
  repositoryId?: number | null
  action?: string | null
  pullRequestNumber?: number | null
  ref?: string | null
  statuses?: LiveWebhookLease["status"][]
}, db?: TrafficControlDb): Promise<LiveWebhookLease | undefined> {
  const resolvedDb = await leasesDb(db)
  const rows = await resolvedDb
    .select()
    .from(liveWebhookLeases)
    .where(and(
      eq(liveWebhookLeases.routeableDeploymentId, params.routeableDeploymentId),
      eq(liveWebhookLeases.event, params.event),
      eq(liveWebhookLeases.installationId, params.installationId),
      maybeEq(liveWebhookLeases.repositoryId, params.repositoryId ?? null),
      maybeEq(liveWebhookLeases.action, params.action ?? null),
      maybeEq(liveWebhookLeases.pullRequestNumber, params.pullRequestNumber ?? null),
      maybeEq(liveWebhookLeases.ref, params.ref ?? null),
    ))
    .limit(5)

  const statuses = params.statuses
  return rows.find((row) => !statuses || statuses.includes(row.status))
}

export async function listCandidateLiveWebhookLeasesForScope(params: {
  event: LiveWebhookLease["event"]
  installationId: number
  repositoryId?: number | null
  statuses?: LiveWebhookLease["status"][]
}, db?: TrafficControlDb): Promise<LiveWebhookLease[]> {
  const resolvedDb = await leasesDb(db)
  const rows = await resolvedDb
    .select()
    .from(liveWebhookLeases)
    .where(and(
      eq(liveWebhookLeases.event, params.event),
      eq(liveWebhookLeases.installationId, params.installationId),
      maybeEq(liveWebhookLeases.repositoryId, params.repositoryId ?? null),
    ))

  return params.statuses ? rows.filter((row) => params.statuses!.includes(row.status)) : rows
}

export async function listActiveLiveWebhookLeasesWithDeployments(
  db?: TrafficControlDb,
): Promise<LiveWebhookLeaseWithDeployment[]> {
  const resolvedDb = await leasesDb(db)
  const rows = await resolvedDb
    .select({
      lease: liveWebhookLeases,
      routeableDeployment: routeableDeployments,
    })
    .from(liveWebhookLeases)
    .innerJoin(routeableDeployments, eq(routeableDeployments.id, liveWebhookLeases.routeableDeploymentId))
    .where(eq(liveWebhookLeases.status, "active"))

  return rows.map((row) => ({
    ...row.lease,
    routeableDeployment: row.routeableDeployment,
  }))
}

export async function createLiveWebhookLease(
  input: CreateLiveWebhookLeaseInput,
  db?: TrafficControlDb,
): Promise<LiveWebhookLease> {
  const resolvedDb = await leasesDb(db)
  const rows = await resolvedDb
    .insert(liveWebhookLeases)
    .values({
      prNumber: input.prNumber,
      routeableDeploymentId: input.routeableDeploymentId,
      actorGithubUserId: input.actorGithubUserId,
      actorGithubLoginSnapshot: input.actorGithubLoginSnapshot,
      scopeClass: input.scopeClass,
      event: input.event,
      installationId: input.installationId,
      repositoryId: input.repositoryId ?? null,
      action: input.action ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      ref: input.ref ?? null,
      githubOwnerTypeSnapshot: input.githubOwnerTypeSnapshot,
      githubOwnerIdSnapshot: input.githubOwnerIdSnapshot,
      githubOwnerLoginSnapshot: input.githubOwnerLoginSnapshot,
      reason: input.reason,
    })
    .returning()

  return rows[0]
}

export async function updateLiveWebhookLease(
  leaseId: string,
  params: UpdateLiveWebhookLeaseParams,
  db?: TrafficControlDb,
): Promise<LiveWebhookLease | undefined> {
  const resolvedDb = await leasesDb(db)
  const rows = await resolvedDb
    .update(liveWebhookLeases)
    .set({
      ...params,
      updatedAt: new Date(),
    })
    .where(eq(liveWebhookLeases.id, leaseId))
    .returning()

  return rows[0]
}

export async function markLiveWebhookLeaseRevoking(
  leaseId: string,
  db?: TrafficControlDb,
): Promise<LiveWebhookLease | undefined> {
  return updateLiveWebhookLease(leaseId, { status: "revoking" }, db)
}

export async function findOverlappingLiveWebhookLeases(params: {
  event: LiveWebhookLease["event"]
  installationId: number
  repositoryId?: number | null
  action?: string | null
  pullRequestNumber?: number | null
  ref?: string | null
  excludeLeaseId?: string
  statuses?: LiveWebhookLease["status"][]
}, db?: TrafficControlDb): Promise<LiveWebhookLease[]> {
  const candidates = await listCandidateLiveWebhookLeasesForScope({
    event: params.event,
    installationId: params.installationId,
    repositoryId: params.repositoryId ?? null,
    statuses: params.statuses,
  }, db)

  return candidates.filter((candidate) => {
    if (params.excludeLeaseId && candidate.id === params.excludeLeaseId) {
      return false
    }

    const matchesAction = candidate.action == null || params.action == null || candidate.action === params.action
    const matchesPr = candidate.pullRequestNumber == null || params.pullRequestNumber == null || candidate.pullRequestNumber === params.pullRequestNumber
    const matchesRef = candidate.ref == null || params.ref == null || candidate.ref === params.ref

    return matchesAction && matchesPr && matchesRef
  })
}
