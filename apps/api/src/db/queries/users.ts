import { and, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { orgMemberships, organizations, users } from "../schema.ts"

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export async function ensureUser(values: {
  login: string
  provider: string
  externalId: string
}): Promise<User> {
  const rows = await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: [users.provider, users.externalId],
      set: { login: values.login },
    })
    .returning()
  return rows[0]
}

export async function ensureMembership(values: {
  orgId: string
  userId: string
  role: string
}): Promise<void> {
  await db
    .insert(orgMemberships)
    .values(values)
    .onConflictDoUpdate({
      target: [orgMemberships.orgId, orgMemberships.userId],
      set: { role: values.role },
    })
}

export async function getMembershipRole(opts: {
  orgId: string
  userId: string
}): Promise<string | null> {
  const rows = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, opts.orgId), eq(orgMemberships.userId, opts.userId)))
    .limit(1)
  return rows[0]?.role ?? null
}

export async function listUserOrgs(userId: string): Promise<
  Array<{
    id: string
    login: string
    role: string
  }>
> {
  const rows = await db
    .select({
      id: organizations.id,
      login: organizations.login,
      role: orgMemberships.role,
    })
    .from(orgMemberships)
    .innerJoin(organizations, eq(orgMemberships.orgId, organizations.id))
    .where(eq(orgMemberships.userId, userId))
  return rows
}
