import { and, asc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { iacJobs, resourceSpans, tfRuns, workspaceDeployments } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import type { RunnerRunCapability } from "./tf-runs.ts"

export type ResourceSpan = typeof resourceSpans.$inferSelect
export type NewResourceSpan = typeof resourceSpans.$inferInsert

/**
 * Insert a new resource span (on "started" event).
 */
export async function insertResourceSpanFromRunner(
  capability: RunnerRunCapability,
  values: Omit<NewResourceSpan, "runId">,
): Promise<boolean> {
  return withDbSpan("insert", "resource_spans", async () => {
    return db.transaction(async (tx) => {
      const active = await tx
        .select({ runId: tfRuns.id })
        .from(tfRuns)
        .innerJoin(iacJobs, eq(iacJobs.id, tfRuns.jobId))
        .innerJoin(
          workspaceDeployments,
          and(
            eq(workspaceDeployments.id, tfRuns.deploymentId),
            eq(workspaceDeployments.runGroupId, tfRuns.runGroupId),
          ),
        )
        .where(
          and(
            eq(tfRuns.id, capability.runId),
            eq(tfRuns.jobId, capability.jobId),
            eq(tfRuns.deploymentId, capability.deploymentId),
            eq(tfRuns.runGroupId, capability.runGroupId),
            eq(tfRuns.status, "running"),
            eq(iacJobs.deploymentId, capability.deploymentId),
            eq(iacJobs.runGroupId, capability.runGroupId),
            eq(iacJobs.status, "running"),
          ),
        )
        .for("share")
        .limit(1)
      if (active.length !== 1) {
        return false
      }
      await tx.insert(resourceSpans).values({ ...values, runId: capability.runId })
      return true
    })
  })
}

/**
 * Complete or error an existing resource span.
 * Matches on (runId, resourceAddress, action, status='started').
 */
export async function completeResourceSpanFromRunner(
  capability: RunnerRunCapability,
  resourceAddress: string,
  action: string,
  update: {
    status: "complete" | "error"
    completedAt: Date
    durationMs?: number
    attributes?: Record<string, unknown>
  },
): Promise<boolean> {
  return withDbSpan("update", "resource_spans", async () => {
    return db.transaction(async (tx) => {
      const active = await tx
        .select({ runId: tfRuns.id })
        .from(tfRuns)
        .innerJoin(iacJobs, eq(iacJobs.id, tfRuns.jobId))
        .innerJoin(
          workspaceDeployments,
          and(
            eq(workspaceDeployments.id, tfRuns.deploymentId),
            eq(workspaceDeployments.runGroupId, tfRuns.runGroupId),
          ),
        )
        .where(
          and(
            eq(tfRuns.id, capability.runId),
            eq(tfRuns.jobId, capability.jobId),
            eq(tfRuns.deploymentId, capability.deploymentId),
            eq(tfRuns.runGroupId, capability.runGroupId),
            eq(tfRuns.status, "running"),
            eq(iacJobs.deploymentId, capability.deploymentId),
            eq(iacJobs.runGroupId, capability.runGroupId),
            eq(iacJobs.status, "running"),
          ),
        )
        .for("share")
        .limit(1)
      if (active.length !== 1) {
        return false
      }
      await tx
        .update(resourceSpans)
        .set({
          status: update.status,
          completedAt: update.completedAt,
          durationMs: update.durationMs,
          ...(update.attributes ? { attributes: update.attributes } : {}),
        })
        .where(
          and(
            eq(resourceSpans.runId, capability.runId),
            eq(resourceSpans.resourceAddress, resourceAddress),
            eq(resourceSpans.action, action),
            eq(resourceSpans.status, "started"),
          ),
        )
      return true
    })
  })
}

/**
 * Close any remaining "started" spans for a run.
 * Called when a run completes — some operations (refresh, read) don't emit
 * explicit completion lines in tofu output, so their spans stay open.
 */
export async function closeOrphanedSpans(runId: string, completedAt: Date): Promise<void> {
  return withDbSpan("update", "resource_spans", async () => {
    await db
      .update(resourceSpans)
      .set({
        status: "complete",
        completedAt,
      })
      .where(and(eq(resourceSpans.runId, runId), eq(resourceSpans.status, "started")))
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
