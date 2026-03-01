import { and, desc, eq } from "drizzle-orm"

import type { RunStatus, RunType } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { tfRuns } from "../schema.ts"

export type TfRun = typeof tfRuns.$inferSelect
export type NewTfRun = typeof tfRuns.$inferInsert

/**
 * Create a new TF run record.
 */
export async function createTfRun(values: NewTfRun): Promise<TfRun> {
  const rows = await db.insert(tfRuns).values(values).returning()
  return rows[0]
}

/**
 * Update a run's status and optionally set timing fields.
 */
export async function updateRunStatus(
  runId: string,
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
  await db
    .update(tfRuns)
    .set({ status, ...extra })
    .where(eq(tfRuns.id, runId))
}

/**
 * Find the latest run for a preview, optionally filtered by type.
 */
export async function findLatestRun(
  previewId: string,
  runType?: RunType,
): Promise<TfRun | undefined> {
  const conditions = [eq(tfRuns.previewId, previewId)]
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
}

/**
 * List all runs for a preview.
 */
export async function listRunsForPreview(previewId: string): Promise<TfRun[]> {
  return db
    .select()
    .from(tfRuns)
    .where(eq(tfRuns.previewId, previewId))
    .orderBy(desc(tfRuns.createdAt))
}
