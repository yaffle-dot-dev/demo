import { and, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { organizations, githubInstallations, orgMemberships } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { createJob } from "./jobs.ts"

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert
export type GithubInstallation = typeof githubInstallations.$inferSelect
export type OrgMembership = typeof orgMemberships.$inferSelect

/**
 * Find an organization by its slug (URL-safe identifier).
 */
export async function findOrgBySlug(slug: string): Promise<Organization | undefined> {
  return withDbSpan("select", "organizations", async () => {
    const rows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find an organization by its UUID.
 */
export async function findOrgById(id: string): Promise<Organization | undefined> {
  return withDbSpan("select", "organizations", async () => {
    const rows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1)
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
  data: Partial<Pick<Organization,
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
  >>,
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
export async function findGithubInstallationsForOrg(
  orgId: string,
): Promise<GithubInstallation[]> {
  return withDbSpan("select", "github_installations", async () => {
    return db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.orgId, orgId))
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

/**
 * Ensure an organization and GitHub installation exist for a GitHub App installation.
 * Creates the org if it doesn't exist, and creates/updates the installation record.
 *
 * This is called when:
 * - The GitHub App is installed (creates both org and installation)
 * - A webhook comes in for an existing installation (returns existing)
 */
export async function ensureOrgAndInstallation(data: {
  githubOrgLogin: string
  githubOrgId: number
  installationId: number
}): Promise<{ org: Organization; installation: GithubInstallation; isNew: boolean }> {
  return withDbSpan("upsert", "organizations", async () => {
    // Check if we already have this installation
    const existing = await findGithubInstallation(data.installationId)
    if (existing) {
      const org = await findOrgById(existing.orgId)
      if (org) {
        return { org, installation: existing, isNew: false }
      }
    }

    // Check if we have an installation for this GitHub org already
    const byGithubOrg = await findOrgByGithubOrgLogin(data.githubOrgLogin)
    if (byGithubOrg) {
      // Update the installation ID if it changed (re-install)
      const updated = await db
        .update(githubInstallations)
        .set({
          installationId: data.installationId,
          installationStatus: "active",
          installedAt: new Date(),
        })
        .where(eq(githubInstallations.id, byGithubOrg.installation.id))
        .returning()
      return { org: byGithubOrg.org, installation: updated[0], isNew: false }
    }

    // Create new org and installation
    // Use the GitHub org login as both name and slug
    const slug = data.githubOrgLogin.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const newOrg = await db
      .insert(organizations)
      .values({
        name: data.githubOrgLogin,
        slug,
        membershipMode: "github_self_join",
        provisioningStatus: "pending",
      })
      .returning()

    const newInstallation = await db
      .insert(githubInstallations)
      .values({
        orgId: newOrg[0].id,
        githubOrgId: data.githubOrgId,
        githubOrgLogin: data.githubOrgLogin,
        installationId: data.installationId,
        installedAt: new Date(),
      })
      .returning()

    // Queue async provisioning of AWS resources (KMS key, IAM role)
    await createJob({
      orgId: newOrg[0].id,
      jobType: "org_provision",
      payload: {
        orgId: newOrg[0].id,
        orgSlug: slug,
      },
    })

    return { org: newOrg[0], installation: newInstallation[0], isNew: true }
  })
}

// =============================================================================
// Backwards Compatibility (deprecated - to be removed)
// =============================================================================

/**
 * @deprecated Use findOrgBySlug instead. This exists for migration compatibility.
 */
export async function findOrgByLogin(login: string): Promise<Organization | undefined> {
  // First try as a slug
  const bySlug = await findOrgBySlug(login)
  if (bySlug) return bySlug

  // Fall back to checking github_org_login in installations
  const result = await findOrgByGithubOrgLogin(login)
  return result?.org
}

/**
 * @deprecated Use findOrgByGithubInstallation instead.
 */
export async function findOrgByInstallationId(
  installationId: number,
): Promise<Organization | undefined> {
  return findOrgByGithubInstallation(installationId)
}

/**
 * @deprecated Use ensureOrgAndInstallation instead.
 * This function is for backwards compatibility with existing webhook handlers.
 */
export async function ensureOrg(
  githubOrgLogin: string,
  githubOrgId: number,
  installationId?: number,
): Promise<Organization> {
  // If we have an installation ID, use the new function
  // Note: Check for undefined specifically because 0 is a valid (though unlikely) installation ID
  if (installationId !== undefined) {
    const result = await ensureOrgAndInstallation({
      githubOrgLogin,
      githubOrgId,
      installationId,
    })
    return result.org
  }

  // Otherwise, just look up or create by GitHub org login
  const existing = await findOrgByGithubOrgLogin(githubOrgLogin)
  if (existing) return existing.org

  // Create without installation (shouldn't happen normally)
  const slug = githubOrgLogin.toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const rows = await db
    .insert(organizations)
    .values({
      name: githubOrgLogin,
      slug,
      membershipMode: "github_self_join",
    })
    .returning()
  return rows[0]
}

/**
 * @deprecated Use updateGithubInstallationStatus instead.
 */
export async function updateOrgInstallationStatus(
  githubOrgId: number,
  status: "active" | "suspended" | "uninstalled",
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ installationStatus: status })
    .where(eq(githubInstallations.githubOrgId, githubOrgId))
}

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
