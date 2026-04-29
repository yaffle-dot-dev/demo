import { and, desc, eq, inArray, lte, max, or } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import {
  anonymousSessions,
  hostedOutputModules,
  principalRepoBindings,
  principals,
} from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type Principal = typeof principals.$inferSelect
export type AnonymousSession = typeof anonymousSessions.$inferSelect
export type PrincipalRepoBinding = typeof principalRepoBindings.$inferSelect
export type HostedOutputModule = typeof hostedOutputModules.$inferSelect

export async function createPrincipal(values: typeof principals.$inferInsert): Promise<Principal> {
  return withDbSpan("insert", "principals", async () => {
    const rows = await db.insert(principals).values(values).returning()
    return rows[0]
  })
}

export async function createAnonymousSession(
  values: typeof anonymousSessions.$inferInsert,
): Promise<AnonymousSession> {
  return withDbSpan("insert", "anonymous_sessions", async () => {
    const rows = await db.insert(anonymousSessions).values(values).returning()
    return rows[0]
  })
}

export async function findAnonymousSessionById(
  sessionId: string,
): Promise<{ session: AnonymousSession; principal: Principal } | undefined> {
  return withDbSpan("select", "anonymous_sessions", async () => {
    const rows = await db
      .select({ session: anonymousSessions, principal: principals })
      .from(anonymousSessions)
      .innerJoin(principals, eq(principals.id, anonymousSessions.principalId))
      .where(eq(anonymousSessions.id, sessionId))
      .limit(1)
    return rows[0]
  })
}

export async function findPrincipalById(principalId: string): Promise<Principal | undefined> {
  return withDbSpan("select", "principals", async () => {
    const rows = await db.select().from(principals).where(eq(principals.id, principalId)).limit(1)
    return rows[0]
  })
}

export async function touchPrincipalSession(
  principalId: string,
  sessionId?: string,
): Promise<void> {
  return touchPrincipalActivity({ principalId, sessionId })
}

export async function touchPrincipalActivity(values: {
  principalId: string
  sessionId?: string
  repoBindingId?: string
}): Promise<void> {
  return withDbSpan("update", "principals", async () => {
    const now = new Date()
    await db.update(principals).set({ lastSeenAt: now }).where(eq(principals.id, values.principalId))
    if (values.sessionId) {
      await db
        .update(anonymousSessions)
        .set({ lastSeenAt: now })
        .where(eq(anonymousSessions.id, values.sessionId))
    }
    if (values.repoBindingId) {
      await db
        .update(principalRepoBindings)
        .set({ lastSeenAt: now })
        .where(eq(principalRepoBindings.id, values.repoBindingId))
    }
  })
}

export async function expireInactiveAnonymousSessions(cutoff: Date): Promise<{
  principalCount: number
  sessionCount: number
}> {
  return withDbSpan("update", "anonymous_sessions", async () => {
    const now = new Date()
    const stale = await db
      .select({
        principalId: principals.id,
        sessionId: anonymousSessions.id,
      })
      .from(anonymousSessions)
      .innerJoin(principals, eq(principals.id, anonymousSessions.principalId))
      .where(
        and(
          eq(principals.type, "anonymous_session"),
          eq(principals.status, "active"),
          eq(anonymousSessions.status, "active"),
          or(
            lte(principals.lastSeenAt, cutoff),
            lte(anonymousSessions.lastSeenAt, cutoff),
            lte(anonymousSessions.expiresAt, now),
          ),
        ),
      )

    if (stale.length === 0) {
      return { principalCount: 0, sessionCount: 0 }
    }

    const principalIds = [...new Set(stale.map((row) => row.principalId))]
    const sessionIds = stale.map((row) => row.sessionId)

    await db
      .update(anonymousSessions)
      .set({ status: "expired" })
      .where(inArray(anonymousSessions.id, sessionIds))
    await db
      .update(principals)
      .set({ status: "expired" })
      .where(inArray(principals.id, principalIds))

    return {
      principalCount: principalIds.length,
      sessionCount: sessionIds.length,
    }
  })
}

export async function deleteExpiredAnonymousPrincipalsBefore(cutoff: Date): Promise<{
  principalCount: number
  sessionCount: number
  repoBindingCount: number
  hostedOutputModuleCount: number
}> {
  return withDbSpan("delete", "principals", async () => {
    const expiredPrincipals = await db
      .select({ id: principals.id })
      .from(principals)
      .where(
        and(
          eq(principals.type, "anonymous_session"),
          eq(principals.status, "expired"),
          lte(principals.lastSeenAt, cutoff),
        ),
      )

    if (expiredPrincipals.length === 0) {
      return {
        principalCount: 0,
        sessionCount: 0,
        repoBindingCount: 0,
        hostedOutputModuleCount: 0,
      }
    }

    const principalIds = expiredPrincipals.map((row) => row.id)
    const [sessions, bindings, modules] = await Promise.all([
      db
        .select({ id: anonymousSessions.id })
        .from(anonymousSessions)
        .where(inArray(anonymousSessions.principalId, principalIds)),
      db
        .select({ id: principalRepoBindings.id })
        .from(principalRepoBindings)
        .where(inArray(principalRepoBindings.principalId, principalIds)),
      db
        .select({ id: hostedOutputModules.id })
        .from(hostedOutputModules)
        .where(inArray(hostedOutputModules.principalId, principalIds)),
    ])

    await db.delete(principals).where(inArray(principals.id, principalIds))

    return {
      principalCount: principalIds.length,
      sessionCount: sessions.length,
      repoBindingCount: bindings.length,
      hostedOutputModuleCount: modules.length,
    }
  })
}

export async function ensurePrincipalRepoBinding(values: {
  principalId: string
  canonicalRepoNamespace: string
  localRepoFingerprint: string
}): Promise<PrincipalRepoBinding> {
  return withDbSpan("upsert", "principal_repo_bindings", async () => {
    const rows = await db
      .insert(principalRepoBindings)
      .values(values)
      .onConflictDoUpdate({
        target: [
          principalRepoBindings.principalId,
          principalRepoBindings.canonicalRepoNamespace,
          principalRepoBindings.localRepoFingerprint,
        ],
        set: {
          lastSeenAt: new Date(),
        },
      })
      .returning()

    return rows[0]
  })
}

export async function findPrincipalRepoBindingById(
  bindingId: string,
): Promise<PrincipalRepoBinding | undefined> {
  return withDbSpan("select", "principal_repo_bindings", async () => {
    const rows = await db
      .select()
      .from(principalRepoBindings)
      .where(eq(principalRepoBindings.id, bindingId))
      .limit(1)
    return rows[0]
  })
}

export async function publishHostedOutputModule(values: {
  principalId: string
  repoBindingId: string
  environmentName: string
  workspacePath: string
  stateFingerprint: string
  outputs: Record<string, unknown>
}): Promise<HostedOutputModule> {
  return withDbSpan("insert", "hosted_output_modules", async () => {
    const rows = await db
      .select({ latestVersion: max(hostedOutputModules.versionSerial) })
      .from(hostedOutputModules)
      .where(
        and(
          eq(hostedOutputModules.repoBindingId, values.repoBindingId),
          eq(hostedOutputModules.environmentName, values.environmentName),
          eq(hostedOutputModules.workspacePath, values.workspacePath),
        ),
      )
    const versionSerial = (rows[0]?.latestVersion ?? 0) + 1

    const inserted = await db
      .insert(hostedOutputModules)
      .values({
        ...values,
        versionSerial,
      })
      .returning()

    return inserted[0]
  })
}

export async function listHostedOutputModuleVersions(values: {
  repoBindingId: string
  environmentName: string
  workspacePath: string
}): Promise<HostedOutputModule[]> {
  return withDbSpan("select", "hosted_output_modules", async () => {
    return db
      .select()
      .from(hostedOutputModules)
      .where(
        and(
          eq(hostedOutputModules.repoBindingId, values.repoBindingId),
          eq(hostedOutputModules.environmentName, values.environmentName),
          eq(hostedOutputModules.workspacePath, values.workspacePath),
        ),
      )
      .orderBy(desc(hostedOutputModules.versionSerial))
  })
}

export async function findHostedOutputModuleVersion(values: {
  repoBindingId: string
  environmentName: string
  workspacePath: string
  versionSerial: number
}): Promise<HostedOutputModule | undefined> {
  return withDbSpan("select", "hosted_output_modules", async () => {
    const rows = await db
      .select()
      .from(hostedOutputModules)
      .where(
        and(
          eq(hostedOutputModules.repoBindingId, values.repoBindingId),
          eq(hostedOutputModules.environmentName, values.environmentName),
          eq(hostedOutputModules.workspacePath, values.workspacePath),
          eq(hostedOutputModules.versionSerial, values.versionSerial),
        ),
      )
      .limit(1)
    return rows[0]
  })
}

export async function findHostedOutputModuleById(
  hostedOutputModuleId: string,
): Promise<HostedOutputModule | undefined> {
  return withDbSpan("select", "hosted_output_modules", async () => {
    const rows = await db
      .select()
      .from(hostedOutputModules)
      .where(eq(hostedOutputModules.id, hostedOutputModuleId))
      .limit(1)
    return rows[0]
  })
}
