import { and, desc, eq, gt, type SQL } from "drizzle-orm"

import type { PreviewStatus } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { previews } from "../schema.ts"

export type Preview = typeof previews.$inferSelect
export type NewPreview = typeof previews.$inferInsert

export interface ListPreviewsOptions {
  repo?: string
  status?: PreviewStatus
  prNumber?: number
  limit?: number
  cursor?: string
}

/**
 * Find a preview by its UUID.
 */
export async function findPreviewById(
  id: string,
): Promise<Preview | undefined> {
  const rows = await db
    .select()
    .from(previews)
    .where(eq(previews.id, id))
    .limit(1)
  return rows[0]
}

/**
 * List previews with optional filtering and cursor-based pagination.
 * Cursor is the `createdAt` timestamp of the last item from the previous page.
 */
export async function listPreviews(
  orgId: string,
  opts: ListPreviewsOptions = {},
): Promise<{ items: Preview[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 250)
  const conditions: SQL[] = [eq(previews.orgId, orgId)]

  if (opts.repo) {
    conditions.push(eq(previews.repo, opts.repo))
  }
  if (opts.status) {
    conditions.push(eq(previews.status, opts.status))
  }
  if (opts.prNumber !== undefined) {
    conditions.push(eq(previews.prNumber, opts.prNumber))
  }
  if (opts.cursor) {
    conditions.push(gt(previews.createdAt, new Date(opts.cursor)))
  }

  const rows = await db
    .select()
    .from(previews)
    .where(and(...conditions))
    .orderBy(desc(previews.createdAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null

  return { items, nextCursor }
}

/**
 * Find a preview by org + repo + PR number + workspace path.
 */
export async function findPreview(
  orgId: string,
  repo: string,
  prNumber: number,
  workspacePath: string,
): Promise<Preview | undefined> {
  const rows = await db
    .select()
    .from(previews)
    .where(
      and(
        eq(previews.orgId, orgId),
        eq(previews.repo, repo),
        eq(previews.prNumber, prNumber),
        eq(previews.workspacePath, workspacePath),
      ),
    )
    .limit(1)
  return rows[0]
}

/**
 * Upsert a preview. On conflict (same org/repo/pr/workspace), update the head SHA,
 * branch, and reset status to pending.
 */
export async function upsertPreview(values: NewPreview): Promise<Preview> {
  const rows = await db
    .insert(previews)
    .values(values)
    .onConflictDoUpdate({
      target: [previews.orgId, previews.repo, previews.prNumber, previews.workspacePath],
      set: {
        headSha: values.headSha,
        branch: values.branch,
        installationId: values.installationId,
        requireApproval: values.requireApproval,
        approvers: values.approvers,
        status: "pending",
      },
    })
    .returning()

  return rows[0]
}

/**
 * Update a preview's status.
 */
export async function updatePreviewStatus(
  previewId: string,
  status: PreviewStatus,
): Promise<void> {
  await db
    .update(previews)
    .set({ status })
    .where(eq(previews.id, previewId))
}

/**
 * Update a preview's head SHA (on synchronize events).
 */
export async function updatePreviewHead(
  previewId: string,
  headSha: string,
): Promise<void> {
  await db
    .update(previews)
    .set({ headSha, status: "pending" as PreviewStatus })
    .where(eq(previews.id, previewId))
}
