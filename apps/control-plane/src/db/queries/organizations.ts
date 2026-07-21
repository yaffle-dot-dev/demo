import { and, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { organizations, githubInstallations, orgMemberships } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert
export type GithubInstallation = typeof githubInstallations.$inferSelect
export type OrgMembership = typeof orgMemberships.$inferSelect

/**
 * Find an organization by its slug (URL-safe identifier).
 */
export async function findOrgBySlug(slug: string): Promise<Organization | undefined> {
  return withDbSpan("select", "organizations", async () => {
    const rows = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1)
    return rows[0]
  })
}

/**
 * Find an organization by its UUID.
 */
export async function findOrgById(id: string): Promise<Organization | undefined> {
  return withDbSpan("select", "organizations", async () => {
    const rows = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1)
    return rows[0]
  })
}

/**
 * Create a new organization.
 */
export async function createOrg(data: {
  name: string
  slug: string
  stateBucket?: string
  membershipMode?: "github_self_join" | "invite_only" | "sso_only"
}): Promise<Organization> {
  return withDbSpan("insert", "organizations", async () => {
    const rows = await db
      .insert(organizations)
      .values({
        name: data.name,
        slug: data.slug,
        stateBucket: data.stateBucket ?? null,
        membershipMode: data.membershipMode ?? "github_self_join",
      })
      .returning()
    return rows[0]
  })
}

/**
 * Update an organization.
 */
export async function updateOrg(
  id: string,
  data: Partial<
    Pick<
      Organization,
      | "name"
      | "stateBucket"
      | "membershipMode"
      | "runnerMode"
      | "kmsKeyArn"
      | "kmsKeyAlias"
      | "iamRoleArn"
      | "provisioningStatus"
      | "provisioningError"
      | "provisioningAttempts"
      | "stripeCustomerId"
      | "subscriptionStatus"
      | "planTier"
    >
  >,
): Promise<Organization | undefined> {
  return withDbSpan("update", "organizations", async () => {
    const rows = await db
      .update(organizations)
      .set(data)
      .where(eq(organizations.id, id))
      .returning()
    return rows[0]
  })
}

// =============================================================================
// GitHub Installation Queries
// =============================================================================

/**
 * Find a GitHub installation by its installation ID.
 */
export async function findGithubInstallation(
  installationId: number,
): Promise<GithubInstallation | undefined> {
  return withDbSpan("select", "github_installations", async () => {
    const rows = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find GitHub installations for an organization.
 */
export async function findGithubInstallationsForOrg(orgId: string): Promise<GithubInstallation[]> {
  return withDbSpan("select", "github_installations", async () => {
    return db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId))
  })
}

/**
 * Find the organization for a GitHub installation.
 */
export async function findOrgByGithubInstallation(
  installationId: number,
): Promise<Organization | undefined> {
  return withDbSpan("select", "organizations", async () => {
    const rows = await db
      .select({ org: organizations })
      .from(githubInstallations)
      .innerJoin(organizations, eq(organizations.id, githubInstallations.orgId))
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1)
    return rows[0]?.org
  })
}

/**
 * Find the organization by a GitHub org's login (via installation).
 * This is useful when we get a GitHub webhook with the org login but need the Yaffle org.
 */
export async function findOrgByGithubOrgLogin(
  githubOrgLogin: string,
): Promise<{ org: Organization; installation: GithubInstallation } | undefined> {
  return withDbSpan("select", "organizations", async () => {
    const rows = await db
      .select({ org: organizations, installation: githubInstallations })
      .from(githubInstallations)
      .innerJoin(organizations, eq(organizations.id, githubInstallations.orgId))
      .where(eq(githubInstallations.githubOrgLogin, githubOrgLogin))
      .limit(1)
    return rows[0]
  })
}

/**
 * Create a GitHub installation and optionally create the linked org.
 * This is called when the GitHub App is installed.
 */
export async function createGithubInstallation(data: {
  orgId: string
  githubOrgId: number
  githubOrgLogin: string
  installationId: number
}): Promise<GithubInstallation> {
  return withDbSpan("insert", "github_installations", async () => {
    const rows = await db
      .insert(githubInstallations)
      .values({
        orgId: data.orgId,
        githubOrgId: data.githubOrgId,
        githubOrgLogin: data.githubOrgLogin,
        installationId: data.installationId,
        installedAt: new Date(),
      })
      .returning()
    return rows[0]
  })
}

/**
 * Upsert a GitHub installation as inventory (no org coupling).
 * Used by the installation.created webhook handler.
 */
export async function upsertGithubInstallation(data: {
  githubOrgId: number
  githubOrgLogin: string
  installationId: number
}): Promise<GithubInstallation> {
  return withDbSpan("upsert", "github_installations", async () => {
    const rows = await db
      .insert(githubInstallations)
      .values({
        githubOrgId: data.githubOrgId,
        githubOrgLogin: data.githubOrgLogin,
        installationId: data.installationId,
        installedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          githubOrgLogin: data.githubOrgLogin,
          installationStatus: "active",
          installedAt: new Date(),
        },
      })
      .returning()
    return rows[0]
  })
}

/**
 * Update installation status.
 */
export async function updateGithubInstallationStatus(
  installationId: number,
  status: "active" | "suspended" | "uninstalled",
): Promise<GithubInstallation | undefined> {
  return withDbSpan("update", "github_installations", async () => {
    const rows = await db
      .update(githubInstallations)
      .set({ installationStatus: status })
      .where(eq(githubInstallations.installationId, installationId))
      .returning()
    return rows[0]
  })
}

// =============================================================================
// Installation Lifecycle Functions
// =============================================================================

// =============================================================================
// Org Membership Queries
// =============================================================================

/**
 * Find a user's membership in an organization.
 */
export async function findOrgMembership(
  orgId: string,
  userId: string,
): Promise<OrgMembership | undefined> {
  return withDbSpan("select", "org_memberships", async () => {
    const rows = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .limit(1)
    return rows[0]
  })
}
