/**
 * Backfill script for the multi-org decoupling migration.
 *
 * For the existing yaffle-dot-dev deployment (single org, single installation):
 * 1. Sets repositories.installation_id from the org's installation
 * 2. Creates github_repo_mappings for all active repos -> the org
 *
 * Usage:
 *   pnpm exec tsx src/scripts/backfill-repo-mappings.ts          # dry-run
 *   pnpm exec tsx src/scripts/backfill-repo-mappings.ts --apply   # apply changes
 */
import { db } from "../lib/db.ts"
import { organizations, githubInstallations, repositories, githubRepoMappings } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  console.info(`Backfill repo mappings (${apply ? "APPLY" : "dry-run"} mode)\n`)

  // Step 1: Find all orgs and their installations
  const orgs = await db.select().from(organizations)
  const installs = await db.select().from(githubInstallations)

  console.info(`Found ${orgs.length} organization(s)`)
  console.info(`Found ${installs.length} installation(s)\n`)

  if (orgs.length === 0) {
    console.info("No organizations found. Nothing to backfill.")
    return
  }

  for (const org of orgs) {
    const orgInstalls = installs.filter((i) => i.orgId === org.id)
    if (orgInstalls.length === 0) {
      console.warn(`  [SKIP] Org "${org.slug}" (${org.id}) has no installations`)
      continue
    }

    console.info(`Processing org "${org.slug}" (${org.id})`)

    for (const install of orgInstalls) {
      console.info(`  Installation ${install.installationId} (${install.githubOrgLogin})`)

      // Find repos belonging to this org that don't have installation_id set
      const orgRepos = await db
        .select()
        .from(repositories)
        .where(eq(repositories.orgId, org.id))

      const reposNeedingInstallationId = orgRepos.filter((r) => r.installationId === null)
      console.info(`  ${orgRepos.length} repos total, ${reposNeedingInstallationId.length} need installation_id backfill`)

      // Step 2: Backfill repositories.installation_id
      if (reposNeedingInstallationId.length > 0) {
        if (apply) {
          await db
            .update(repositories)
            .set({ installationId: install.installationId })
            .where(and(eq(repositories.orgId, org.id), isNull(repositories.installationId)))
          console.info(`  [APPLIED] Set installation_id=${install.installationId} on ${reposNeedingInstallationId.length} repos`)
        } else {
          console.info(`  [DRY-RUN] Would set installation_id=${install.installationId} on ${reposNeedingInstallationId.length} repos`)
        }
      }

      // Step 3: Create github_repo_mappings for active repos
      const activeRepos = orgRepos.filter((r) => r.isActive)
      console.info(`  ${activeRepos.length} active repos to map`)

      let created = 0
      let skipped = 0

      for (const repo of activeRepos) {
        // Check if mapping already exists
        const existing = await db
          .select({ id: githubRepoMappings.id })
          .from(githubRepoMappings)
          .where(
            and(
              eq(githubRepoMappings.installationId, install.installationId),
              eq(githubRepoMappings.githubRepoId, repo.githubId),
            ),
          )
          .limit(1)

        if (existing.length > 0) {
          skipped++
          continue
        }

        if (apply) {
          await db.insert(githubRepoMappings).values({
            orgId: org.id,
            installationId: install.installationId,
            githubRepoId: repo.githubId,
            createdBy: null, // migration backfill
          })
          created++
        } else {
          created++
        }
      }

      if (apply) {
        console.info(`  [APPLIED] Created ${created} mappings, skipped ${skipped} (already exist)`)
      } else {
        console.info(`  [DRY-RUN] Would create ${created} mappings, skip ${skipped} (already exist)`)
      }
    }

    console.info("")
  }

  // Step 4: Verification
  const totalMappings = await db.select({ id: githubRepoMappings.id }).from(githubRepoMappings)
  const reposWithoutInstallationId = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(isNull(repositories.installationId))

  console.info("--- Verification ---")
  console.info(`Total repo mappings: ${totalMappings.length}`)
  console.info(`Repos without installation_id: ${reposWithoutInstallationId.length}`)

  if (reposWithoutInstallationId.length > 0 && apply) {
    console.warn("WARNING: Some repos still have no installation_id. These may be orphaned.")
  }

  console.info("\nDone.")
}

main().catch((err) => {
  console.error("Backfill failed:", err)
  process.exit(1)
})
