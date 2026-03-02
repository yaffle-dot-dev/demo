import { and, eq } from "drizzle-orm"

import type { PreviewStatus } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { previews } from "../schema.ts"

export type Preview = typeof previews.$inferSelect
export type NewPreview = typeof previews.$inferInsert

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
