import { and, eq } from "drizzle-orm"
import { uuidv7 } from "uuidv7"

import { db } from "../../lib/db.ts"
import { orgMemberships, organizations, user, account } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type OrgMembership = typeof orgMemberships.$inferSelect
export type MembershipSource = "github_self_join" | "invite" | "scim" | "admin_bootstrap" | "manual"
export type User = typeof user.$inferSelect

/**
 * Find a user by their GitHub account ID.
 */
export async function findUserByGithubId(githubId: string): Promise<User | undefined> {
  return withDbSpan("select", "user", async () => {
    const rows = await db
      .select({ user: user })
      .from(account)
      .innerJoin(user, eq(account.userId, user.id))
      .where(and(
        eq(account.providerId, "github"),
        eq(account.accountId, githubId),
      ))
      .limit(1)
    return rows[0]?.user
  })
}

/**
 * Get a user's GitHub account ID from their internal user ID.
 * Returns the numeric GitHub user ID used for matching PR authors.
 */
export async function getGithubIdForUser(userId: string): Promise<number | null> {
  return withDbSpan("select", "account", async () => {
    const rows = await db
      .select({ accountId: account.accountId })
      .from(account)
      .where(and(
        eq(account.userId, userId),
        eq(account.providerId, "github"),
      ))
      .limit(1)
    const accountId = rows[0]?.accountId
    return accountId ? Number(accountId) : null
  })
}

/**
 * Find a user by their ID.
 */
export async function findUserById(id: string): Promise<User | undefined> {
  return withDbSpan("select", "user", async () => {
    const rows = await db
      .select()
      .from(user)
      .where(eq(user.id, id))
      .limit(1)
    return rows[0]
  })
}

/**
 * Ensure a user exists for a GitHub account.
 * If the user doesn't exist, create them.
 *
 * Note: This is for webhook-initiated user creation. Users who log in via
 * BetterAuth will already have their user record created.
 */
export async function ensureUser(data: {
  login: string
  provider: "github"
  externalId: string
}): Promise<User> {
  return withDbSpan("upsert", "user", async () => {
    // Check if user already exists via their GitHub account
    const existing = await findUserByGithubId(data.externalId)
    if (existing) return existing

    // Create a new user and account
    const userId = uuidv7()
    const email = `${data.login}@github.users.yaffle.dev` // Placeholder email

    await db.insert(user).values({
      id: userId,
      name: data.login,
      email,
      emailVerified: false,
    })

    await db.insert(account).values({
      id: uuidv7(),
      accountId: data.externalId,
      providerId: "github",
      userId,
    })

    const created = await findUserById(userId)
    if (!created) throw new Error("Failed to create user")
    return created
  })
}

/**
 * Create or update a membership for a user in an organization.
 */
export async function ensureMembership(values: {
  orgId: string
  userId: string
  role: string
  source: MembershipSource
}): Promise<OrgMembership> {
  return withDbSpan("upsert", "org_memberships", async () => {
    const rows = await db
      .insert(orgMemberships)
      .values(values)
      .onConflictDoUpdate({
        target: [orgMemberships.orgId, orgMemberships.userId],
        set: { role: values.role },
      })
      .returning()
    return rows[0]
  })
}

/**
 * Get a user's role in an organization.
 */
export async function getMembershipRole(opts: {
  orgId: string
  userId: string
}): Promise<string | null> {
  return withDbSpan("select", "org_memberships", async () => {
    const rows = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, opts.orgId), eq(orgMemberships.userId, opts.userId)))
      .limit(1)
    return rows[0]?.role ?? null
  })
}

/**
 * Get a user's membership details in an organization.
 */
export async function getMembership(opts: {
  orgId: string
  userId: string
}): Promise<OrgMembership | null> {
  return withDbSpan("select", "org_memberships", async () => {
    const rows = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, opts.orgId), eq(orgMemberships.userId, opts.userId)))
      .limit(1)
    return rows[0] ?? null
  })
}

/**
 * List all organizations a user is a member of.
 */
export async function listUserOrgs(userId: string): Promise<
  Array<{
    id: string
    name: string
    slug: string
    role: string
    source: string
    planTier: string
    subscriptionStatus: string
  }>
> {
  return withDbSpan("select", "org_memberships", async () => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: orgMemberships.role,
        source: orgMemberships.source,
        planTier: organizations.planTier,
        subscriptionStatus: organizations.subscriptionStatus,
      })
      .from(orgMemberships)
      .innerJoin(organizations, eq(orgMemberships.orgId, organizations.id))
      .where(eq(orgMemberships.userId, userId))
    return rows
  })
}

/**
 * List all members of an organization.
 */
export async function listOrgMembers(orgId: string): Promise<
  Array<{
    userId: string
    email: string
    name: string
    role: string
    source: string
    joinedAt: Date
  }>
> {
  return withDbSpan("select", "org_memberships", async () => {
    const rows = await db
      .select({
        userId: user.id,
        email: user.email,
        name: user.name,
        role: orgMemberships.role,
        source: orgMemberships.source,
        joinedAt: orgMemberships.createdAt,
      })
      .from(orgMemberships)
      .innerJoin(user, eq(orgMemberships.userId, user.id))
      .where(eq(orgMemberships.orgId, orgId))
    return rows
  })
}

/**
 * Remove a user's membership from an organization.
 */
export async function removeMembership(opts: {
  orgId: string
  userId: string
}): Promise<void> {
  return withDbSpan("delete", "org_memberships", async () => {
    await db
      .delete(orgMemberships)
      .where(and(eq(orgMemberships.orgId, opts.orgId), eq(orgMemberships.userId, opts.userId)))
  })
}

/**
 * Update a user's role in an organization.
 */
export async function updateMembershipRole(opts: {
  orgId: string
  userId: string
  role: string
}): Promise<OrgMembership | null> {
  return withDbSpan("update", "org_memberships", async () => {
    const rows = await db
      .update(orgMemberships)
      .set({ role: opts.role })
      .where(and(eq(orgMemberships.orgId, opts.orgId), eq(orgMemberships.userId, opts.userId)))
      .returning()
    return rows[0] ?? null
  })
}
