import { and, asc, eq, inArray } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { environmentGroupProjections } from "../schema.ts"

export type EnvironmentGroupProjection = typeof environmentGroupProjections.$inferSelect
export type NewEnvironmentGroupProjection = typeof environmentGroupProjections.$inferInsert

export async function upsertEnvironmentGroupProjection(
  row: NewEnvironmentGroupProjection,
): Promise<EnvironmentGroupProjection> {
  return withDbSpan("insert", "environment_group_projections", async () => {
    const rows = await db
      .insert(environmentGroupProjections)
      .values(row)
      .onConflictDoUpdate({
        target: [
          environmentGroupProjections.orgId,
          environmentGroupProjections.repo,
          environmentGroupProjections.environmentKind,
          environmentGroupProjections.environmentName,
        ],
        set: {
          sourceKind: row.sourceKind ?? null,
          sourceMetadata: row.sourceMetadata ?? null,
          status: row.status,
          headSha: row.headSha,
          updatedAt: row.updatedAt,
          workspaceCount: row.workspaceCount,
          blockedWorkspaceCount: row.blockedWorkspaceCount,
          degradedWorkspaceCount: row.degradedWorkspaceCount,
          payload: row.payload,
          rebuiltAt: row.rebuiltAt,
          rebuildError: row.rebuildError ?? null,
          version: row.version,
          rowUpdatedAt: row.rowUpdatedAt ?? new Date(),
        },
      })
      .returning()

    return rows[0]
  })
}

export async function upsertEnvironmentGroupProjections(
  rows: NewEnvironmentGroupProjection[],
): Promise<void> {
  if (rows.length === 0) {
    return
  }

  await withDbSpan("insert", "environment_group_projections", async () => {
    await db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .insert(environmentGroupProjections)
          .values(row)
          .onConflictDoUpdate({
            target: [
              environmentGroupProjections.orgId,
              environmentGroupProjections.repo,
              environmentGroupProjections.environmentKind,
              environmentGroupProjections.environmentName,
            ],
            set: {
              sourceKind: row.sourceKind ?? null,
              sourceMetadata: row.sourceMetadata ?? null,
              status: row.status,
              headSha: row.headSha,
              updatedAt: row.updatedAt,
              workspaceCount: row.workspaceCount,
              blockedWorkspaceCount: row.blockedWorkspaceCount,
              degradedWorkspaceCount: row.degradedWorkspaceCount,
              payload: row.payload,
              rebuiltAt: row.rebuiltAt,
              rebuildError: row.rebuildError ?? null,
              version: row.version,
              rowUpdatedAt: row.rowUpdatedAt ?? new Date(),
            },
          })
      }
    })
  })
}

export async function listEnvironmentGroupProjections(params: {
  orgId: string
  environmentKind?: string
  repo?: string
}): Promise<EnvironmentGroupProjection[]> {
  return withDbSpan("select", "environment_group_projections", async () => {
    const conditions = [eq(environmentGroupProjections.orgId, params.orgId)]

    if (params.environmentKind) {
      conditions.push(eq(environmentGroupProjections.environmentKind, params.environmentKind))
    }

    if (params.repo) {
      conditions.push(eq(environmentGroupProjections.repo, params.repo))
    }

    return db
      .select()
      .from(environmentGroupProjections)
      .where(and(...conditions))
      .orderBy(
        asc(environmentGroupProjections.repo),
        asc(environmentGroupProjections.environmentKind),
        asc(environmentGroupProjections.environmentName),
      )
  })
}

export async function findEnvironmentGroupProjection(params: {
  orgId: string
  repo: string
  environmentKind: string
  environmentName: string
}): Promise<EnvironmentGroupProjection | undefined> {
  return withDbSpan("select", "environment_group_projections", async () => {
    const rows = await db
      .select()
      .from(environmentGroupProjections)
      .where(and(
        eq(environmentGroupProjections.orgId, params.orgId),
        eq(environmentGroupProjections.repo, params.repo),
        eq(environmentGroupProjections.environmentKind, params.environmentKind),
        eq(environmentGroupProjections.environmentName, params.environmentName),
      ))
      .limit(1)

    return rows[0]
  })
}

export async function deleteEnvironmentGroupProjectionsByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return
  }

  await withDbSpan("delete", "environment_group_projections", async () => {
    await db
      .delete(environmentGroupProjections)
      .where(inArray(environmentGroupProjections.id, ids))
  })
}
