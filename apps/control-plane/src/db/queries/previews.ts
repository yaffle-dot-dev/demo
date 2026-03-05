import { and, desc, eq, gt, notInArray, type SQL } from "drizzle-orm"

import type { PreviewStatus } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { previews } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { events } from "../../lib/events.ts"

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
  return withDbSpan("select", "previews", async () => {
    const rows = await db
      .select()
      .from(previews)
      .where(eq(previews.id, id))
      .limit(1)
    return rows[0]
  })
}

/**
 * List previews with optional filtering and cursor-based pagination.
 * Cursor is the `createdAt` timestamp of the last item from the previous page.
 */
export async function listPreviews(
  orgId: string,
  opts: ListPreviewsOptions = {},
): Promise<{ items: Preview[]; nextCursor: string | null }> {
  return withDbSpan("select", "previews", async () => {
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
  })
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
  return withDbSpan("select", "previews", async () => {
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
  })
}

/**
 * Upsert a preview. On conflict (same org/repo/pr/workspace), update the head SHA,
 * branch, and reset status to pending.
 */
export async function upsertPreview(values: NewPreview): Promise<Preview> {
  return withDbSpan("upsert", "previews", async () => {
    const rows = await db
      .insert(previews)
      .values(values)
      .onConflictDoUpdate({
        target: [previews.orgId, previews.repo, previews.prNumber, previews.workspacePath],
        set: {
          headSha: values.headSha,
          branch: values.branch,
          installationId: values.installationId,
          authorGithubId: values.authorGithubId,
          authorLogin: values.authorLogin,
          requireApproval: values.requireApproval,
          approvers: values.approvers,
          status: "pending",
        },
      })
      .returning()

    const preview = rows[0]
    // Emit event so SSE streams pick up the new headSha
    events.emitPreviewUpdate(preview.id, preview.orgId, preview.repo, preview.prNumber)
    return preview
  })
}

/**
 * Update a preview's status.
 */
export async function updatePreviewStatus(
  previewId: string,
  status: PreviewStatus,
): Promise<void> {
  return withDbSpan("update", "previews", async () => {
    const updated = await db
      .update(previews)
      .set({ status })
      .where(eq(previews.id, previewId))
      .returning({ orgId: previews.orgId, repo: previews.repo, prNumber: previews.prNumber })
    if (updated.length > 0) {
      const { orgId, repo, prNumber } = updated[0]
      events.emitPreviewUpdate(previewId, orgId, repo, prNumber)
    }
  })
}

/**
 * Update a preview's head SHA (on synchronize events).
 */
export async function updatePreviewHead(
  previewId: string,
  headSha: string,
): Promise<void> {
  return withDbSpan("update", "previews", async () => {
    const updated = await db
      .update(previews)
      .set({ headSha, status: "pending" as PreviewStatus })
      .where(eq(previews.id, previewId))
      .returning({ orgId: previews.orgId, repo: previews.repo, prNumber: previews.prNumber })
    if (updated.length > 0) {
      const { orgId, repo, prNumber } = updated[0]
      events.emitPreviewUpdate(previewId, orgId, repo, prNumber)
    }
  })
}

/**
 * Find all previews for a PR (all workspaces).
 */
export async function findPreviewsByPr(
  orgId: string,
  repo: string,
  prNumber: number,
): Promise<Preview[]> {
  return withDbSpan("select", "previews", async () => {
    return db
      .select()
      .from(previews)
      .where(
        and(
          eq(previews.orgId, orgId),
          eq(previews.repo, repo),
          eq(previews.prNumber, prNumber),
        ),
      )
      .orderBy(previews.workspacePath)
  })
}

/**
 * Find all previews for a long-lived environment (branch with prNumber=0).
 */
export async function findPreviewsByEnv(
  orgId: string,
  repo: string,
  branch: string,
): Promise<Preview[]> {
  return withDbSpan("select", "previews", async () => {
    return db
      .select()
      .from(previews)
      .where(
        and(
          eq(previews.orgId, orgId),
          eq(previews.repo, repo),
          eq(previews.branch, branch),
          eq(previews.prNumber, 0),
        ),
      )
      .orderBy(previews.workspacePath)
  })
}

/**
 * Mark production previews as destroyed if they're no longer in the config.
 * This handles cases where workspaces are removed from .yaffle/config.yml.
 */
export async function markRemovedWorkspacesDestroyed(
  orgId: string,
  repo: string,
  branch: string,
  headSha: string,
  activeWorkspacePaths: string[],
): Promise<number> {
  return withDbSpan("update", "previews", async () => {
    if (activeWorkspacePaths.length === 0) {
      // If no workspaces are active, mark all production previews for this branch as destroyed
      const result = await db
        .update(previews)
        .set({ status: "destroyed" as PreviewStatus, headSha })
        .where(
          and(
            eq(previews.orgId, orgId),
            eq(previews.repo, repo),
            eq(previews.branch, branch),
            eq(previews.prNumber, 0), // Production only
          ),
        )
        .returning({ id: previews.id })
      return result.length
    }

    const result = await db
      .update(previews)
      .set({ status: "destroyed" as PreviewStatus, headSha })
      .where(
        and(
          eq(previews.orgId, orgId),
          eq(previews.repo, repo),
          eq(previews.branch, branch),
          eq(previews.prNumber, 0), // Production only
          notInArray(previews.workspacePath, activeWorkspacePaths),
        ),
      )
      .returning({ id: previews.id })
    return result.length
  })
}
