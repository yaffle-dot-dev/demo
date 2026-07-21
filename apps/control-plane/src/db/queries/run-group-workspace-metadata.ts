import { and, eq, inArray } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { runGroupWorkspaceMetadata } from "../schema.ts"

export type RunGroupWorkspaceMetadata = typeof runGroupWorkspaceMetadata.$inferSelect
export type RunGroupWorkspaceMetadataInsert = typeof runGroupWorkspaceMetadata.$inferInsert

export function buildRunGroupWorkspaceMetadataKey(
  runGroupId: string,
  workspacePath: string,
): string {
  return `${runGroupId}:${workspacePath}`
}

export async function upsertRunGroupWorkspaceMetadata(
  rows: RunGroupWorkspaceMetadataInsert[],
): Promise<void> {
  if (rows.length === 0) {
    return
  }

  await withDbSpan("insert", "run_group_workspace_metadata", async () => {
    await db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .insert(runGroupWorkspaceMetadata)
          .values(row)
          .onConflictDoUpdate({
            target: [runGroupWorkspaceMetadata.runGroupId, runGroupWorkspaceMetadata.workspacePath],
            set: {
              providerRequirements: row.providerRequirements,
              extractionStatus: row.extractionStatus,
              degradationKind: row.degradationKind ?? null,
              errorKind: row.errorKind ?? null,
              errorMessage: row.errorMessage ?? null,
              retryable: row.retryable ?? false,
              source: row.source,
              extractedAt: row.extractedAt ?? null,
              updatedAt: row.updatedAt ?? new Date(),
            },
          })
      }
    })
  })
}

export async function findRunGroupWorkspaceMetadata(
  runGroupId: string,
  workspacePath: string,
): Promise<RunGroupWorkspaceMetadata | undefined> {
  return withDbSpan("select", "run_group_workspace_metadata", async () => {
    const rows = await db
      .select()
      .from(runGroupWorkspaceMetadata)
      .where(
        and(
          eq(runGroupWorkspaceMetadata.runGroupId, runGroupId),
          eq(runGroupWorkspaceMetadata.workspacePath, workspacePath),
        ),
      )
      .limit(1)

    return rows[0]
  })
}

export async function findRunGroupWorkspaceMetadataForRunGroups(
  runGroupIds: string[],
): Promise<Map<string, RunGroupWorkspaceMetadata>> {
  if (runGroupIds.length === 0) {
    return new Map()
  }

  return withDbSpan("select", "run_group_workspace_metadata", async () => {
    const rows = await db
      .select()
      .from(runGroupWorkspaceMetadata)
      .where(inArray(runGroupWorkspaceMetadata.runGroupId, runGroupIds))

    return new Map(
      rows.map((row) => [
        buildRunGroupWorkspaceMetadataKey(row.runGroupId, row.workspacePath),
        row,
      ]),
    )
  })
}
