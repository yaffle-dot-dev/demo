import { and, asc, desc, eq, inArray, lte, max, or } from "drizzle-orm"
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

export async function findAccountPrincipalByUserId(userId: string): Promise<Principal | undefined> {
  return withDbSpan("select", "principals", async () => {
    const rows = await db
      .select()
      .from(principals)
      .where(and(eq(principals.type, "account"), eq(principals.userId, userId)))
      .limit(1)
    return rows[0]
  })
}

export async function ensureAccountPrincipal(values: { userId: string }): Promise<Principal> {
  return withDbSpan("upsert", "principals", async () => {
    const existing = await findAccountPrincipalByUserId(values.userId)
    if (existing) {
      if (existing.status !== "active") {
        const rows = await db
          .update(principals)
          .set({ status: "active", lastSeenAt: new Date() })
          .where(eq(principals.id, existing.id))
          .returning()
        return rows[0]
      }

      return existing
    }

    const rows = await db
      .insert(principals)
      .values({
        type: "account",
        userId: values.userId,
      })
      .returning()
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
    await db
      .update(principals)
      .set({ lastSeenAt: now })
      .where(eq(principals.id, values.principalId))
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

export async function findPrincipalRepoBindingByNamespaceAndFingerprint(values: {
  canonicalRepoNamespace: string
  localRepoFingerprint: string
}): Promise<PrincipalRepoBinding | undefined> {
  return withDbSpan("select", "principal_repo_bindings", async () => {
    const rows = await db
      .select()
      .from(principalRepoBindings)
      .where(
        and(
          eq(principalRepoBindings.canonicalRepoNamespace, values.canonicalRepoNamespace),
          eq(principalRepoBindings.localRepoFingerprint, values.localRepoFingerprint),
        ),
      )
      .orderBy(desc(principalRepoBindings.lastSeenAt), desc(principalRepoBindings.createdAt))
      .limit(1)

    return rows[0]
  })
}

export async function migrateAnonymousPrincipalToAccount(values: {
  anonymousPrincipalId: string
  accountPrincipalId: string
}): Promise<{
  reboundBindingCount: number
  mergedBindingCount: number
  movedModuleCount: number
}> {
  return withDbSpan("update", "principals", async () => {
    return db.transaction(async (tx) => {
      const [anonymousPrincipal] = await tx
        .select()
        .from(principals)
        .where(eq(principals.id, values.anonymousPrincipalId))
        .limit(1)
      const [accountPrincipal] = await tx
        .select()
        .from(principals)
        .where(eq(principals.id, values.accountPrincipalId))
        .limit(1)

      if (!anonymousPrincipal || anonymousPrincipal.type !== "anonymous_session") {
        throw new Error("anonymous principal not found")
      }
      if (!accountPrincipal || accountPrincipal.type !== "account") {
        throw new Error("account principal not found")
      }
      if (anonymousPrincipal.status !== "active") {
        return {
          reboundBindingCount: 0,
          mergedBindingCount: 0,
          movedModuleCount: 0,
        }
      }

      const now = new Date()
      const anonymousBindings = await tx
        .select()
        .from(principalRepoBindings)
        .where(eq(principalRepoBindings.principalId, anonymousPrincipal.id))

      let reboundBindingCount = 0
      let mergedBindingCount = 0
      let movedModuleCount = 0

      for (const anonymousBinding of anonymousBindings) {
        const [accountBinding] = await tx
          .select()
          .from(principalRepoBindings)
          .where(
            and(
              eq(principalRepoBindings.principalId, accountPrincipal.id),
              eq(
                principalRepoBindings.canonicalRepoNamespace,
                anonymousBinding.canonicalRepoNamespace,
              ),
              eq(principalRepoBindings.localRepoFingerprint, anonymousBinding.localRepoFingerprint),
            ),
          )
          .limit(1)

        const anonymousModules = await tx
          .select()
          .from(hostedOutputModules)
          .where(eq(hostedOutputModules.repoBindingId, anonymousBinding.id))
          .orderBy(asc(hostedOutputModules.environmentName), asc(hostedOutputModules.workspacePath))

        if (!accountBinding) {
          await tx
            .update(principalRepoBindings)
            .set({ principalId: accountPrincipal.id, lastSeenAt: now })
            .where(eq(principalRepoBindings.id, anonymousBinding.id))
          await tx
            .update(hostedOutputModules)
            .set({ principalId: accountPrincipal.id })
            .where(eq(hostedOutputModules.repoBindingId, anonymousBinding.id))

          reboundBindingCount += 1
          movedModuleCount += anonymousModules.length
          continue
        }

        mergedBindingCount += 1

        await tx
          .update(hostedOutputModules)
          .set({
            principalId: accountPrincipal.id,
            repoBindingId: accountBinding.id,
          })
          .where(eq(hostedOutputModules.repoBindingId, anonymousBinding.id))
        movedModuleCount += anonymousModules.length
        await tx
          .delete(principalRepoBindings)
          .where(eq(principalRepoBindings.id, anonymousBinding.id))
      }

      await tx
        .update(anonymousSessions)
        .set({ status: "revoked", lastSeenAt: now })
        .where(eq(anonymousSessions.principalId, anonymousPrincipal.id))
      await tx
        .update(principals)
        .set({ status: "revoked", lastSeenAt: now })
        .where(eq(principals.id, anonymousPrincipal.id))
      await tx
        .update(principals)
        .set({ lastSeenAt: now })
        .where(eq(principals.id, accountPrincipal.id))

      return {
        reboundBindingCount,
        mergedBindingCount,
        movedModuleCount,
      }
    })
  })
}

export async function publishHostedOutputModule(values: {
  principalId: string
  repoBindingId: string
  canonicalRepoNamespace: string
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
          eq(hostedOutputModules.canonicalRepoNamespace, values.canonicalRepoNamespace),
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
  canonicalRepoNamespace: string
  environmentName: string
  workspacePath: string
}): Promise<HostedOutputModule[]> {
  return withDbSpan("select", "hosted_output_modules", async () => {
    return db
      .select()
      .from(hostedOutputModules)
      .where(
        and(
          eq(hostedOutputModules.canonicalRepoNamespace, values.canonicalRepoNamespace),
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
  canonicalRepoNamespace: string
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
          eq(hostedOutputModules.canonicalRepoNamespace, values.canonicalRepoNamespace),
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
