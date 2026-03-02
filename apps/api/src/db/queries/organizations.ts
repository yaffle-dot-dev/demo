import { eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { organizations } from "../schema.ts"

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert

/**
 * Find an organization by its GitHub installation owner login.
 */
export async function findOrgByLogin(login: string): Promise<Organization | undefined> {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.login, login))
    .limit(1)
  return rows[0]
}

/**
 * Find an organization by its GitHub numeric ID.
 */
export async function findOrgByGithubId(githubId: number): Promise<Organization | undefined> {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.githubId, githubId))
    .limit(1)
  return rows[0]
}

/**
 * Find an organization by its UUID.
 */
export async function findOrgById(id: string): Promise<Organization | undefined> {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1)
  return rows[0]
}

/**
 * Ensure an organization exists. Creates a stub if missing.
 * In the real flow, orgs are created during GitHub App installation,
 * but for early dev we auto-create from webhook context.
 */
export async function ensureOrg(login: string, githubId: number): Promise<Organization> {
  const existing = await findOrgByLogin(login)
  if (existing) return existing

  const rows = await db
    .insert(organizations)
    .values({
      githubId,
      login,
      // Placeholder bucket -- will be configured properly during onboarding
      stateBucket: `yaffle-state-${login}`,
    })
    .onConflictDoUpdate({
      target: organizations.githubId,
      set: { login },
    })
    .returning()

  return rows[0]
}
