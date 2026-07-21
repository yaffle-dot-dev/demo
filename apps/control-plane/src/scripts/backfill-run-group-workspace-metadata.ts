import { and, eq, isNotNull, ne } from "drizzle-orm"

import { db } from "../lib/db.ts"
import {
  buildRunGroupWorkspaceMetadataKey,
  findRunGroupWorkspaceMetadataForRunGroups,
} from "../db/queries/run-group-workspace-metadata.ts"
import { findRunGroupsByIds } from "../db/queries/run-groups.ts"
import { organizations, workspaceDeployments } from "../db/schema.ts"
import { persistRunGroupWorkspaceMetadataFromArchive } from "../lib/run-group-workspace-metadata.ts"

function parseArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return null
  }

  return process.argv[index + 1] ?? null
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const orgSlug = parseArg("--org")
  const whereClause = orgSlug
    ? and(
        ne(workspaceDeployments.status, "destroyed"),
        isNotNull(workspaceDeployments.runGroupId),
        eq(organizations.slug, orgSlug),
      )
    : and(ne(workspaceDeployments.status, "destroyed"), isNotNull(workspaceDeployments.runGroupId))

  const rows = await db
    .select({
      orgId: workspaceDeployments.orgId,
      orgSlug: organizations.slug,
      runGroupId: workspaceDeployments.runGroupId,
      workspacePath: workspaceDeployments.workspacePath,
    })
    .from(workspaceDeployments)
    .innerJoin(organizations, eq(organizations.id, workspaceDeployments.orgId))
    .where(whereClause)

  const uniqueRows = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    if (!row.runGroupId) {
      continue
    }

    uniqueRows.set(buildRunGroupWorkspaceMetadataKey(row.runGroupId, row.workspacePath), row)
  }

  const runGroupIds = [
    ...new Set(
      [...uniqueRows.values()]
        .map((row) => row.runGroupId)
        .filter((runGroupId): runGroupId is string => runGroupId != null),
    ),
  ]

  const [existingMetadata, runGroupsById] = await Promise.all([
    findRunGroupWorkspaceMetadataForRunGroups(runGroupIds),
    findRunGroupsByIds(runGroupIds),
  ])

  const missingByRunGroup = new Map<
    string,
    {
      orgSlug: string
      workspacePaths: string[]
    }
  >()

  for (const [key, row] of uniqueRows) {
    if (existingMetadata.has(key) || !row.runGroupId) {
      continue
    }

    const existing = missingByRunGroup.get(row.runGroupId)
    if (existing) {
      existing.workspacePaths.push(row.workspacePath)
    } else {
      missingByRunGroup.set(row.runGroupId, {
        orgSlug: row.orgSlug,
        workspacePaths: [row.workspacePath],
      })
    }
  }

  console.log(
    `[backfill-run-group-workspace-metadata] active pairs=${uniqueRows.size} missing=${missingByRunGroup.size}`,
  )

  if (missingByRunGroup.size === 0) {
    return
  }

  for (const [runGroupId, entry] of missingByRunGroup) {
    const runGroup = runGroupsById.get(runGroupId)
    if (!runGroup) {
      console.warn(`[skip] run group ${runGroupId} not found`)
      continue
    }

    const workspacePaths = [...new Set(entry.workspacePaths)].sort()
    console.log(
      `- ${entry.orgSlug} ${runGroup.repo} ${runGroup.environmentName} runGroup=${runGroupId} workspaces=${workspacePaths.join(",")}`,
    )

    if (!apply) {
      continue
    }

    await persistRunGroupWorkspaceMetadataFromArchive({
      runGroup,
      workspacePaths,
      workspaceS3Key: runGroup.workspaceS3Key,
      source: "backfill",
    })
  }
}

await main()
