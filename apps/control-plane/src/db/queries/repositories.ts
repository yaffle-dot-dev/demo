import { eq, and } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { repositories } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type Repository = typeof repositories.$inferSelect
export type NewRepository = typeof repositories.$inferInsert

/**
 * Find a repository by GitHub ID
 */
export async function findRepoByGithubId(githubId: number): Promise<Repository | undefined> {
  return withDbSpan("select", "repositories", async () => {
    const rows = await db
      .select()
      .from(repositories)
      .where(eq(repositories.githubId, githubId))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find a repository by its full GitHub name (e.g. "acme/platform").
 */
export async function findRepoByFullName(fullName: string): Promise<Repository | undefined> {
  return withDbSpan("select", "repositories", async () => {
    const rows = await db
      .select()
      .from(repositories)
      .where(eq(repositories.fullName, fullName))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find a repository by org ID and name
 */
export async function findRepoByName(orgId: string, name: string): Promise<Repository | undefined> {
  return withDbSpan("select", "repositories", async () => {
    const rows = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.orgId, orgId), eq(repositories.name, name)))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find a repository by installation ID and name.
 * Useful when repo inventory exists before an org-scoped repository row does.
 */
export async function findRepoByInstallationAndName(
  installationId: number,
  name: string,
): Promise<Repository | undefined> {
  return withDbSpan("select", "repositories", async () => {
    const rows = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.installationId, installationId), eq(repositories.name, name)))
      .limit(1)
    return rows[0]
  })
}

/**
 * List all active repositories for an org
 */
export async function listReposForOrg(orgId: string): Promise<Repository[]> {
  return withDbSpan("select", "repositories", async () => {
    return db
      .select()
      .from(repositories)
      .where(and(eq(repositories.orgId, orgId), eq(repositories.isActive, true)))
  })
}

/**
 * Ensure a repository exists, creating it if necessary.
 * Uses upsert to handle race conditions from duplicate webhooks.
 */
export async function ensureRepo(params: {
  orgId: string
  githubId: number
  name: string
  fullName: string
  defaultBranch?: string
}): Promise<Repository> {
  return withDbSpan("upsert", "repositories", async () => {
    const rows = await db
      .insert(repositories)
      .values({
        orgId: params.orgId,
        githubId: params.githubId,
        name: params.name,
        fullName: params.fullName,
        defaultBranch: params.defaultBranch ?? "main",
      })
      .onConflictDoUpdate({
        target: repositories.githubId,
        set: {
          name: params.name,
          fullName: params.fullName,
          isActive: true,
        },
      })
      .returning()

    return rows[0]
  })
}

/**
 * Upsert a repository as inventory (no org coupling).
 * Used by installation webhook handlers for tracking repo access.
 */
export async function upsertRepoInventory(params: {
  installationId: number
  githubId: number
  name: string
  fullName: string
  defaultBranch?: string
}): Promise<Repository> {
  return withDbSpan("upsert", "repositories", async () => {
    const rows = await db
      .insert(repositories)
      .values({
        installationId: params.installationId,
        githubId: params.githubId,
        name: params.name,
        fullName: params.fullName,
        defaultBranch: params.defaultBranch ?? "main",
      })
      .onConflictDoUpdate({
        target: repositories.githubId,
        set: {
          installationId: params.installationId,
          name: params.name,
          fullName: params.fullName,
          isActive: true,
        },
      })
      .returning()

    return rows[0]
  })
}

/**
 * Deactivate all repos for an installation (app uninstalled).
 */
export async function deactivateAllReposForInstallation(installationId: number): Promise<void> {
  return withDbSpan("update", "repositories", async () => {
    await db
      .update(repositories)
      .set({ isActive: false })
      .where(eq(repositories.installationId, installationId))
  })
}

/**
 * Mark repositories as inactive (app no longer has access)
 */
export async function deactivateRepos(githubIds: number[]): Promise<void> {
  if (githubIds.length === 0) return

  return withDbSpan("update", "repositories", async () => {
    for (const githubId of githubIds) {
      await db
        .update(repositories)
        .set({ isActive: false })
        .where(eq(repositories.githubId, githubId))
    }
  })
}

/**
 * Mark all repos for an org as inactive (app uninstalled)
 */
export async function deactivateAllReposForOrg(orgId: string): Promise<void> {
  return withDbSpan("update", "repositories", async () => {
    await db.update(repositories).set({ isActive: false }).where(eq(repositories.orgId, orgId))
  })
}

/**
 * Reactivate repositories (app reinstalled or repos re-added)
 */
export async function reactivateRepos(githubIds: number[]): Promise<void> {
  if (githubIds.length === 0) return

  return withDbSpan("update", "repositories", async () => {
    for (const githubId of githubIds) {
      await db
        .update(repositories)
        .set({ isActive: true })
        .where(eq(repositories.githubId, githubId))
    }
  })
}
