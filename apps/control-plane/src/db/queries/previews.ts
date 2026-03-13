import { and, arrayContains, desc, eq, gt, notInArray, sql, type SQL } from "drizzle-orm"

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
          runGroupId: values.runGroupId,
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

// =============================================================================
// DAG Coordination
// =============================================================================

/**
 * Set the upstream dependencies for a preview.
 * Called when creating/updating previews during webhook processing.
 */
export async function setPreviewUpstreams(
  previewId: string,
  upstreamIds: string[],
): Promise<void> {
  return withDbSpan("update", "previews", async () => {
    await db
      .update(previews)
      .set({ upstreamIds })
      .where(eq(previews.id, previewId))
  })
}

/**
 * Add a completed upstream to a preview's completed_upstreams set.
 * Returns the updated preview so we can check if it's now ready.
 */
export async function addCompletedUpstream(
  previewId: string,
  completedUpstreamId: string,
): Promise<Preview | undefined> {
  return withDbSpan("update", "previews", async () => {
    // Use array_append to add the ID if not already present
    const rows = await db
      .update(previews)
      .set({
        completedUpstreams: sql`
          CASE
            WHEN ${completedUpstreamId} = ANY(${previews.completedUpstreams})
            THEN ${previews.completedUpstreams}
            ELSE array_append(${previews.completedUpstreams}, ${completedUpstreamId})
          END
        `,
      })
      .where(eq(previews.id, previewId))
      .returning()

    const preview = rows[0]
    if (preview) {
      events.emitPreviewUpdate(preview.id, preview.orgId, preview.repo, preview.prNumber)
    }
    return preview
  })
}

/**
 * Check if a preview is ready to execute (all upstreams completed).
 */
export function isPreviewReady(preview: Preview): boolean {
  const upstreams = new Set(preview.upstreamIds)
  const completed = new Set(preview.completedUpstreams)

  // All upstream IDs must be in the completed set
  for (const upstreamId of upstreams) {
    if (!completed.has(upstreamId)) {
      return false
    }
  }
  return true
}

/**
 * Find all downstream previews that depend on a given preview.
 * These are previews where upstream_ids contains the given preview's ID.
 */
export async function findDownstreamPreviews(
  previewId: string,
): Promise<Preview[]> {
  return withDbSpan("select", "previews", async () => {
    return db
      .select()
      .from(previews)
      .where(arrayContains(previews.upstreamIds, [previewId]))
  })
}

/**
 * Find all previews in a run group.
 */
export async function findPreviewsByRunGroup(
  runGroupId: string,
): Promise<Preview[]> {
  return withDbSpan("select", "previews", async () => {
    return db
      .select()
      .from(previews)
      .where(eq(previews.runGroupId, runGroupId))
      .orderBy(previews.workspacePath)
  })
}

/**
 * Mark a preview as skipped (due to upstream failure).
 */
export async function markPreviewSkipped(
  previewId: string,
  _reason: string, // Kept for logging/debugging purposes
): Promise<void> {
  return withDbSpan("update", "previews", async () => {
    const updated = await db
      .update(previews)
      .set({
        status: "failed" as PreviewStatus, // "skipped" maps to "failed" status with reason
        completedAt: new Date(),
      })
      .where(eq(previews.id, previewId))
      .returning({ orgId: previews.orgId, repo: previews.repo, prNumber: previews.prNumber })

    if (updated.length > 0) {
      const { orgId, repo, prNumber } = updated[0]
      events.emitPreviewUpdate(previewId, orgId, repo, prNumber)
    }
  })
}

/**
 * Record approval on a preview.
 */
export async function recordPreviewApproval(
  previewId: string,
  approvedBy: string,
): Promise<void> {
  return withDbSpan("update", "previews", async () => {
    const updated = await db
      .update(previews)
      .set({
        approvedAt: new Date(),
        approvedBy,
      })
      .where(eq(previews.id, previewId))
      .returning({ orgId: previews.orgId, repo: previews.repo, prNumber: previews.prNumber })

    if (updated.length > 0) {
      const { orgId, repo, prNumber } = updated[0]
      events.emitPreviewUpdate(previewId, orgId, repo, prNumber)
    }
  })
}

/**
 * Update a preview's run group and reset status to pending.
 * Used when manually re-running a preview.
 */
export async function updatePreviewRunGroup(
  previewId: string,
  runGroupId: string,
): Promise<Preview | undefined> {
  return withDbSpan("update", "previews", async () => {
    const updated = await db
      .update(previews)
      .set({
        runGroupId,
        status: "pending" as PreviewStatus,
        // Clear approval state for fresh run
        approvedAt: null,
        approvedBy: null,
      })
      .where(eq(previews.id, previewId))
      .returning()

    if (updated.length > 0) {
      const preview = updated[0]
      events.emitPreviewUpdate(previewId, preview.orgId, preview.repo, preview.prNumber)
      return preview
    }
    return undefined
  })
}

/**
 * Find previews that are pending and have all upstreams completed (ready to plan).
 * Used by the scheduler to find work.
 */
export async function findReadyToExecutePreviews(
  runGroupId: string,
  status: PreviewStatus,
): Promise<Preview[]> {
  return withDbSpan("select", "previews", async () => {
    // Get all previews in the run group with the specified status
    const allPreviews = await db
      .select()
      .from(previews)
      .where(
        and(
          eq(previews.runGroupId, runGroupId),
          eq(previews.status, status),
        ),
      )

    // Filter to only those where completed_upstreams contains all upstream_ids
    return allPreviews.filter(isPreviewReady)
  })
}
