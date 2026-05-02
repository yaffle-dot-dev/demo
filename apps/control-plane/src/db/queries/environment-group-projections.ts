import { and, asc, eq, inArray } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { events } from "../../lib/events.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { environmentGroupProjections } from "../schema.ts"

export type EnvironmentGroupProjection = typeof environmentGroupProjections.$inferSelect
export type NewEnvironmentGroupProjection = typeof environmentGroupProjections.$inferInsert

export async function upsertEnvironmentGroupProjection(
  row: NewEnvironmentGroupProjection,
): Promise<EnvironmentGroupProjection> {
  return withDbSpan("insert", "environment_group_projections", async () => {
    const existing = await findEnvironmentGroupProjection({
      orgId: row.orgId,
      repo: row.repo,
      environmentKind: row.environmentKind,
      environmentName: row.environmentName,
    })

    const payloadChanged = JSON.stringify(existing?.payload ?? null) !== JSON.stringify(row.payload)
      || existing?.status !== row.status
      || existing?.headSha !== row.headSha
      || existing?.updatedAt?.getTime() !== row.updatedAt?.getTime()

    const nextVersion = payloadChanged
      ? (existing?.version ?? 0) + 1
      : (existing?.version ?? row.version ?? 1)

    const rows = await db
      .insert(environmentGroupProjections)
      .values({
        ...row,
        version: nextVersion,
      })
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
          version: nextVersion,
          rowUpdatedAt: row.rowUpdatedAt ?? new Date(),
        },
      })
      .returning()

    const updated = rows[0]
    if (payloadChanged) {
      events.emitEnvironmentGroupProjectionUpdate(
        updated.orgId,
        updated.repo,
        updated.environmentKind as "named" | "transient",
        updated.environmentName,
      )
    }

    return updated
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
        const existingRows = await tx
          .select()
          .from(environmentGroupProjections)
          .where(and(
            eq(environmentGroupProjections.orgId, row.orgId),
            eq(environmentGroupProjections.repo, row.repo),
            eq(environmentGroupProjections.environmentKind, row.environmentKind),
            eq(environmentGroupProjections.environmentName, row.environmentName),
          ))
          .limit(1)

        const existing = existingRows[0]
        const payloadChanged = JSON.stringify(existing?.payload ?? null) !== JSON.stringify(row.payload)
          || existing?.status !== row.status
          || existing?.headSha !== row.headSha
          || existing?.updatedAt?.getTime() !== row.updatedAt?.getTime()

        const nextVersion = payloadChanged
          ? (existing?.version ?? 0) + 1
          : (existing?.version ?? row.version ?? 1)

        await tx
          .insert(environmentGroupProjections)
          .values({
            ...row,
            version: nextVersion,
          })
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
              version: nextVersion,
              rowUpdatedAt: row.rowUpdatedAt ?? new Date(),
            },
          })

        if (payloadChanged) {
          events.emitEnvironmentGroupProjectionUpdate(
            row.orgId,
            row.repo,
            row.environmentKind as "named" | "transient",
            row.environmentName,
          )
        }
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
