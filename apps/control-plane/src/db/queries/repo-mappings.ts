import { and, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { githubRepoMappings } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type GithubRepoMapping = typeof githubRepoMappings.$inferSelect

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
 * List all repo mappings for an org.
 */
export async function listRepoMappingsForOrg(orgId: string): Promise<GithubRepoMapping[]> {
  return withDbSpan("select", "github_repo_mappings", async () => {
    return db
      .select()
      .from(githubRepoMappings)
      .where(eq(githubRepoMappings.orgId, orgId))
  })
}
