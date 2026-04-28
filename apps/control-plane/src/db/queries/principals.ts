import { and, desc, eq, max } from "drizzle-orm"

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

export async function touchPrincipalSession(
  principalId: string,
  sessionId?: string,
): Promise<void> {
  return withDbSpan("update", "principals", async () => {
    const now = new Date()
    await db.update(principals).set({ lastSeenAt: now }).where(eq(principals.id, principalId))
    if (sessionId) {
      await db
        .update(anonymousSessions)
        .set({ lastSeenAt: now })
        .where(eq(anonymousSessions.id, sessionId))
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
