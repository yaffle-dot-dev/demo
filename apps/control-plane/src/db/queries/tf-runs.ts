import { and, desc, eq, inArray, sql } from "drizzle-orm"

import type { RunStatus, RunType } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import type { EnvironmentKind } from "../../lib/config-toml.ts"
import { tfRuns } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { events } from "../../lib/events.ts"
import { recomputeRunGroupStatus } from "./run-groups.ts"
import { findDeploymentById } from "./workspace-deployments.ts"
import { enqueueEnvironmentGroupProjectionRebuild } from "../../jobs/environment-group-projections.ts"

export type TfRun = typeof tfRuns.$inferSelect
export type NewTfRun = typeof tfRuns.$inferInsert
export type TfRunListItem = Pick<
  TfRun,
  | "id"
  | "deploymentId"
  | "runGroupId"
  | "runType"
  | "status"
  | "checkRunId"
  | "planSummary"
  | "outputs"
  | "errorMessage"
  | "startedAt"
  | "completedAt"
  | "createdAt"
>

export type TfRunLatestSummaryItem = Pick<
  TfRun,
  | "id"
  | "deploymentId"
  | "runType"
  | "status"
  | "planSummary"
  | "completedAt"
>
export type TfRunOutputsItem = Pick<
  TfRun,
  | "id"
  | "deploymentId"
  | "runType"
  | "status"
  | "outputs"
  | "createdAt"
>

function selectRunListFields() {
  return {
    id: tfRuns.id,
    deploymentId: tfRuns.deploymentId,
    runGroupId: tfRuns.runGroupId,
    runType: tfRuns.runType,
    status: tfRuns.status,
    checkRunId: tfRuns.checkRunId,
    planSummary: tfRuns.planSummary,
    outputs: tfRuns.outputs,
    errorMessage: tfRuns.errorMessage,
    startedAt: tfRuns.startedAt,
    completedAt: tfRuns.completedAt,
    createdAt: tfRuns.createdAt,
  }
}

function selectLatestRunSummaryFields() {
  return {
    id: tfRuns.id,
    deploymentId: tfRuns.deploymentId,
    runType: tfRuns.runType,
    status: tfRuns.status,
    planSummary: tfRuns.planSummary,
    completedAt: tfRuns.completedAt,
  }
}

function groupRunsByDeployment(rows: TfRunListItem[]): Map<string, TfRunListItem[]> {
  const map = new Map<string, TfRunListItem[]>()

  for (const row of rows) {
    const existing = map.get(row.deploymentId)
    if (existing) {
      existing.push(row)
    } else {
      map.set(row.deploymentId, [row])
    }
  }

  return map
}

/**
 * Create a new TF run record.
 */
export async function createTfRun(values: NewTfRun): Promise<TfRun> {
  return withDbSpan("insert", "tf_runs", async () => {
    const rows = await db.insert(tfRuns).values(values).returning()
    const row = rows[0]
    const deployment = await findDeploymentById(values.deploymentId)
    if (deployment) {
      await enqueueEnvironmentGroupProjectionRebuild({
        orgId: deployment.orgId,
        repo: deployment.repo,
        environmentKind: deployment.environmentKind as EnvironmentKind,
        environmentName: deployment.environmentName,
      })
    }
    return row
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
    planFileS3Key?: string
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
      .returning({ runGroupId: tfRuns.runGroupId, deploymentId: tfRuns.deploymentId })

    events.emitRunUpdate(runId, previewId)

    const deployment = updated?.deploymentId ? await findDeploymentById(updated.deploymentId) : undefined
    if (deployment) {
      await enqueueEnvironmentGroupProjectionRebuild({
        orgId: deployment.orgId,
        repo: deployment.repo,
        environmentKind: deployment.environmentKind as EnvironmentKind,
        environmentName: deployment.environmentName,
      })
    }

    // Recompute run group status if this run belongs to a group
    if (updated?.runGroupId) {
      await recomputeRunGroupStatus(updated.runGroupId)
    }
  })
}

/**
 * Get the current log-output state for a run.
 * Used to detect the first runner output chunk without issuing an extra query
 * for every subsequent log append.
 */
export async function getRunLogState(runId: string): Promise<{
  startedAt: Date | null
  runType: string
  hasLogOutput: boolean
} | undefined> {
  return withDbSpan("select", "tf_runs", async () => {
    const rows = await db
      .select({
        startedAt: tfRuns.startedAt,
        runType: tfRuns.runType,
        logOutput: tfRuns.logOutput,
      })
      .from(tfRuns)
      .where(eq(tfRuns.id, runId))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return undefined
    }

    return {
      startedAt: row.startedAt,
      runType: row.runType,
      hasLogOutput: !!row.logOutput,
    }
  })
}

export async function getRunLogSnapshot(runId: string): Promise<{
  status: RunStatus
  logOutput: string | null
} | undefined> {
  return withDbSpan("select", "tf_runs", async () => {
    const rows = await db
      .select({
        status: tfRuns.status,
        logOutput: tfRuns.logOutput,
      })
      .from(tfRuns)
      .where(eq(tfRuns.id, runId))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return undefined
    }

    return {
      status: row.status as RunStatus,
      logOutput: row.logOutput,
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
 * Replace the stored log output for a run.
 * Used as a final durable snapshot when a worker completes or fails.
 */
export async function replaceRunLog(
  runId: string,
  previewId: string,
  output: string,
): Promise<void> {
  return withDbSpan("update", "tf_runs", async () => {
    await db
      .update(tfRuns)
      .set({ logOutput: output })
      .where(eq(tfRuns.id, runId))
    events.emitRunUpdate(runId, previewId)
  })
}

/**
 * Find the latest run per deployment for a batch of deployment IDs.
 * Optionally filtered by run type. Returns a Map keyed by deploymentId.
 *
 * Fetches all matching runs sorted by deployment + time, then deduplicates
 * in JS to keep the first (latest) per deployment. Bounded by deployment count.
 */
export async function findLatestRunsForDeployments(
  deploymentIds: string[],
  runType?: RunType,
): Promise<Map<string, TfRunLatestSummaryItem>> {
  if (deploymentIds.length === 0) return new Map()

  return withDbSpan("select", "tf_runs", async () => {
    const conditions = [inArray(tfRuns.deploymentId, deploymentIds)]
    if (runType) {
      conditions.push(eq(tfRuns.runType, runType))
    }

    const rows = await db
      .selectDistinctOn([tfRuns.deploymentId], selectLatestRunSummaryFields())
      .from(tfRuns)
      .where(and(...conditions))
      .orderBy(tfRuns.deploymentId, desc(tfRuns.createdAt), desc(tfRuns.id))

    const map = new Map<string, TfRunLatestSummaryItem>()
    for (const row of rows) {
      map.set(row.deploymentId, row)
    }
    return map
  })
}

/**
 * List runs for a batch of deployments using the slim projection needed by repo/env routes.
 * Optionally restrict to a set of run groups so we don't load unrelated history.
 */
export async function listRunsForDeployments(
  deploymentIds: string[],
  opts?: {
    runGroupIds?: string[]
  },
): Promise<Map<string, TfRunListItem[]>> {
  if (deploymentIds.length === 0) {
    return new Map()
  }

  if (opts?.runGroupIds && opts.runGroupIds.length === 0) {
    return new Map(deploymentIds.map((deploymentId) => [deploymentId, []]))
  }

  return withDbSpan("select", "tf_runs", async () => {
    const conditions = [inArray(tfRuns.deploymentId, deploymentIds)]

    if (opts?.runGroupIds) {
      conditions.push(inArray(tfRuns.runGroupId, opts.runGroupIds))
    }

    const rows = await db
      .select(selectRunListFields())
      .from(tfRuns)
      .where(and(...conditions))
      .orderBy(tfRuns.deploymentId, desc(tfRuns.createdAt))

    return groupRunsByDeployment(rows)
  })
}

/**
 * Find the latest successful run per deployment using the minimal fields needed by the UI.
 */
export async function findLatestSuccessfulRunsForDeployments(
  deploymentIds: string[],
  runType?: RunType,
): Promise<Map<string, TfRunOutputsItem>> {
  if (deploymentIds.length === 0) {
    return new Map()
  }

  return withDbSpan("select", "tf_runs", async () => {
    const conditions = [
      inArray(tfRuns.deploymentId, deploymentIds),
      eq(tfRuns.status, "success"),
    ]

    if (runType) {
      conditions.push(eq(tfRuns.runType, runType))
    }

    const rows = await db
      .select({
        id: tfRuns.id,
        deploymentId: tfRuns.deploymentId,
        runType: tfRuns.runType,
        status: tfRuns.status,
        outputs: tfRuns.outputs,
        createdAt: tfRuns.createdAt,
      })
      .from(tfRuns)
      .where(and(...conditions))
      .orderBy(tfRuns.deploymentId, desc(tfRuns.createdAt))

    const map = new Map<string, TfRunOutputsItem>()
    for (const row of rows) {
      if (!map.has(row.deploymentId)) {
        map.set(row.deploymentId, row)
      }
    }
    return map
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
 * Find the latest successful run for a deployment, optionally filtered by type.
 */
export async function findLatestSuccessfulRun(
  deploymentId: string,
  runType?: RunType,
): Promise<TfRun | undefined> {
  return withDbSpan("select", "tf_runs", async () => {
    const conditions = [
      eq(tfRuns.deploymentId, deploymentId),
      eq(tfRuns.status, "success"),
    ]
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
export async function listRunsForDeployment(deploymentId: string): Promise<TfRunListItem[]> {
  return withDbSpan("select", "tf_runs", async () => {
    return db
      .select(selectRunListFields())
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
