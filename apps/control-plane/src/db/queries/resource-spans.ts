import { and, asc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { resourceSpans } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type ResourceSpan = typeof resourceSpans.$inferSelect
export type NewResourceSpan = typeof resourceSpans.$inferInsert

/**
 * Insert a new resource span (on "started" event).
 */
export async function insertResourceSpan(values: NewResourceSpan): Promise<ResourceSpan> {
  return withDbSpan("insert", "resource_spans", async () => {
    const rows = await db.insert(resourceSpans).values(values).returning()
    return rows[0]
  })
}

/**
 * Complete or error an existing resource span.
 * Matches on (runId, resourceAddress, action, status='started').
 */
export async function completeResourceSpan(
  runId: string,
  resourceAddress: string,
  action: string,
  update: {
    status: "complete" | "error"
    completedAt: Date
    durationMs?: number
    attributes?: Record<string, unknown>
  },
): Promise<void> {
  return withDbSpan("update", "resource_spans", async () => {
    await db
      .update(resourceSpans)
      .set({
        status: update.status,
        completedAt: update.completedAt,
        durationMs: update.durationMs,
        ...(update.attributes ? { attributes: update.attributes } : {}),
      })
      .where(
        and(
          eq(resourceSpans.runId, runId),
          eq(resourceSpans.resourceAddress, resourceAddress),
          eq(resourceSpans.action, action),
          eq(resourceSpans.status, "started"),
        ),
      )
  })
}

/**
 * Close any remaining "started" spans for a run.
 * Called when a run completes — some operations (refresh, read) don't emit
 * explicit completion lines in tofu output, so their spans stay open.
 */
export async function closeOrphanedSpans(
  runId: string,
  completedAt: Date,
): Promise<void> {
  return withDbSpan("update", "resource_spans", async () => {
    await db
      .update(resourceSpans)
      .set({
        status: "complete",
        completedAt,
      })
      .where(
        and(
          eq(resourceSpans.runId, runId),
          eq(resourceSpans.status, "started"),
        ),
      )
  })
}

/**
 * Get all spans for a run, ordered by startedAt.
 */
export async function getSpansForRun(runId: string): Promise<ResourceSpan[]> {
  return withDbSpan("select", "resource_spans", async () => {
    return db
      .select()
      .from(resourceSpans)
      .where(eq(resourceSpans.runId, runId))
      .orderBy(asc(resourceSpans.startedAt))
  })
}
