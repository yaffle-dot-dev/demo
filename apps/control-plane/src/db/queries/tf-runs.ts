import { and, desc, eq, sql } from "drizzle-orm"

import type { RunStatus, RunType } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { tfRuns } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { events } from "../../lib/events.ts"
import { recomputeRunGroupStatus } from "./run-groups.ts"

export type TfRun = typeof tfRuns.$inferSelect
export type NewTfRun = typeof tfRuns.$inferInsert

/**
 * Create a new TF run record.
 */
export async function createTfRun(values: NewTfRun): Promise<TfRun> {
  return withDbSpan("insert", "tf_runs", async () => {
    const rows = await db.insert(tfRuns).values(values).returning()
    return rows[0]
  })
}

/**
 * Update a run's status and optionally set timing fields.
 * Also recomputes the parent run group's status if applicable.
 */
export async function updateRunStatus(
  runId: string,
  previewId: string,
  status: RunStatus,
  extra?: {
    checkRunId?: number
    ecsTaskArn?: string
    planSummary?: string
    planJson?: unknown
    outputs?: unknown
    errorMessage?: string
    startedAt?: Date
    completedAt?: Date
  },
): Promise<void> {
  return withDbSpan("update", "tf_runs", async () => {
    // Update the run
    const [updated] = await db
      .update(tfRuns)
      .set({ status, ...extra })
      .where(eq(tfRuns.id, runId))
      .returning({ runGroupId: tfRuns.runGroupId })

    events.emitRunUpdate(runId, previewId)

    // Recompute run group status if this run belongs to a group
    if (updated?.runGroupId) {
      await recomputeRunGroupStatus(updated.runGroupId)
    }
  })
}

/**
 * Append log output to a run.
 */
export async function appendRunLog(
  runId: string,
  previewId: string,
  chunk: string,
): Promise<void> {
  return withDbSpan("update", "tf_runs", async () => {
    await db
      .update(tfRuns)
      .set({ logOutput: sql`coalesce(${tfRuns.logOutput}, '') || ${chunk}` })
      .where(eq(tfRuns.id, runId))
    events.emitRunUpdate(runId, previewId)
  })
}

/**
 * Find the latest run for a deployment, optionally filtered by type.
 */
export async function findLatestRun(
  deploymentId: string,
  runType?: RunType,
): Promise<TfRun | undefined> {
  return withDbSpan("select", "tf_runs", async () => {
    const conditions = [eq(tfRuns.deploymentId, deploymentId)]
    if (runType) {
      conditions.push(eq(tfRuns.runType, runType))
    }

    const rows = await db
      .select()
      .from(tfRuns)
      .where(and(...conditions))
      .orderBy(desc(tfRuns.createdAt))
      .limit(1)

    return rows[0]
  })
}

/**
 * List all runs for a deployment.
 */
export async function listRunsForDeployment(deploymentId: string): Promise<TfRun[]> {
  return withDbSpan("select", "tf_runs", async () => {
    return db
      .select()
      .from(tfRuns)
      .where(eq(tfRuns.deploymentId, deploymentId))
      .orderBy(desc(tfRuns.createdAt))
  })
}

// Alias for backward compatibility
export const listRunsForPreview = listRunsForDeployment

/**
 * Find a single run by its UUID.
 */
export async function findRunById(
  runId: string,
): Promise<TfRun | undefined> {
  return withDbSpan("select", "tf_runs", async () => {
    const rows = await db
      .select()
      .from(tfRuns)
      .where(eq(tfRuns.id, runId))
      .limit(1)
    return rows[0]
  })
}

/**
 * List all runs for a run group.
 */
export async function listRunsForRunGroup(runGroupId: string): Promise<TfRun[]> {
  return withDbSpan("select", "tf_runs", async () => {
    return db
      .select()
      .from(tfRuns)
      .where(eq(tfRuns.runGroupId, runGroupId))
      .orderBy(desc(tfRuns.createdAt))
  })
}
