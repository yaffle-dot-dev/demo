import { and, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { githubRepoMappings, repositories, githubInstallations, organizations } from "../schema.ts"
import { user } from "../auth-schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type GithubRepoMapping = typeof githubRepoMappings.$inferSelect

export interface EnrichedRepoMapping {
  id: string
  orgId: string
  installationId: number
  githubRepoId: number
  /** Repository full name (e.g. "acme/infra") from repositories table, if known */
  repoFullName: string | null
  /** GitHub org login from installations table (e.g. "acme") */
  githubOrgLogin: string | null
  /** Display name of user who created the mapping */
  createdByName: string | null
  createdAt: Date
}

export interface InstallationRepoOwner {
  githubRepoId: number
  orgId: string
  orgSlug: string
}

/**
 * Find which org a repo is mapped to.
 * This is the primary routing lookup for webhook events.
 */
export async function findOrgForRepo(
  installationId: number,
  githubRepoId: number,
): Promise<{ orgId: string } | undefined> {
  return withDbSpan("select", "github_repo_mappings", async () => {
    const rows = await db
      .select({ orgId: githubRepoMappings.orgId })
      .from(githubRepoMappings)
      .where(
        and(
          eq(githubRepoMappings.installationId, installationId),
          eq(githubRepoMappings.githubRepoId, githubRepoId),
        ),
      )
      .limit(1)
    return rows[0]
  })
}

/**
 * Create a repo-to-org mapping.
 * The unique constraint on (installation_id, github_repo_id) ensures
 * a repo can only be mapped to one org at a time.
 */
export async function setRepoMapping(params: {
  orgId: string
  installationId: number
  githubRepoId: number
  createdBy?: string
}): Promise<GithubRepoMapping> {
  return withDbSpan("insert", "github_repo_mappings", async () => {
    const rows = await db
      .insert(githubRepoMappings)
      .values({
        orgId: params.orgId,
        installationId: params.installationId,
        githubRepoId: params.githubRepoId,
        createdBy: params.createdBy,
      })
      .onConflictDoUpdate({
        target: [githubRepoMappings.installationId, githubRepoMappings.githubRepoId],
        set: {
          orgId: params.orgId,
          createdBy: params.createdBy,
        },
      })
      .returning()

    return rows[0]
  })
}

/**
 * Remove a repo-to-org mapping.
 * After removal, webhooks for this repo will be ignored (fail-closed).
 */
export async function removeRepoMapping(
  installationId: number,
  githubRepoId: number,
): Promise<void> {
  return withDbSpan("delete", "github_repo_mappings", async () => {
    await db
      .delete(githubRepoMappings)
      .where(
        and(
          eq(githubRepoMappings.installationId, installationId),
          eq(githubRepoMappings.githubRepoId, githubRepoId),
        ),
      )
  })
}

/**
 * List all repo mappings for an org, enriched with repo name and creator info.
 */
export async function listRepoMappingsForOrg(orgId: string): Promise<EnrichedRepoMapping[]> {
  return withDbSpan("select", "github_repo_mappings", async () => {
    const rows = await db
      .select({
        id: githubRepoMappings.id,
        orgId: githubRepoMappings.orgId,
        installationId: githubRepoMappings.installationId,
        githubRepoId: githubRepoMappings.githubRepoId,
        repoFullName: repositories.fullName,
        githubOrgLogin: githubInstallations.githubOrgLogin,
        createdByName: user.name,
        createdAt: githubRepoMappings.createdAt,
      })
      .from(githubRepoMappings)
      .leftJoin(repositories, eq(repositories.githubId, githubRepoMappings.githubRepoId))
      .leftJoin(githubInstallations, eq(githubInstallations.installationId, githubRepoMappings.installationId))
      .leftJoin(user, eq(user.id, githubRepoMappings.createdBy))
      .where(eq(githubRepoMappings.orgId, orgId))

    return rows
  })
}

/**
 * List repo ownership for a GitHub installation.
 * Used to surface whether repos are already linked elsewhere before selection.
 */
export async function listRepoOwnersForInstallation(
  installationId: number,
): Promise<InstallationRepoOwner[]> {
  return withDbSpan("select", "github_repo_mappings", async () => {
    return db
      .select({
        githubRepoId: githubRepoMappings.githubRepoId,
        orgId: githubRepoMappings.orgId,
        orgSlug: organizations.slug,
      })
      .from(githubRepoMappings)
      .innerJoin(organizations, eq(organizations.id, githubRepoMappings.orgId))
      .where(eq(githubRepoMappings.installationId, installationId))
  })
}
