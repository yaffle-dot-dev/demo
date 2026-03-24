import { and, desc, eq, inArray, isNull, or } from "drizzle-orm"

import type { RunStatus } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { runGroups, tfRuns } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import type { SerializableDependencyGraph } from "../../lib/dependency-graph.ts"

export type RunGroup = typeof runGroups.$inferSelect
export type NewRunGroup = typeof runGroups.$inferInsert

export type RunGroupTrigger = "pr_opened" | "pr_sync" | "push" | "manual"

type AggregatedRunGroupStatus = "pending" | "running" | "success" | "failed" | "partial"

const SUCCESS_RUN_STATUSES = new Set(["success", "skipped"])
const FAILURE_RUN_STATUSES = new Set(["failed", "system_error"])
const TERMINAL_RUN_STATUSES = new Set(["success", "skipped", "failed", "cancelled", "system_error"])

export function deriveRunGroupStatusFromRunStatuses(statuses: string[]): {
  status: AggregatedRunGroupStatus
  isComplete: boolean
} {
  const allPending = statuses.every((s) => s === "pending")
  if (allPending) {
    return { status: "pending", isComplete: false }
  }

  const anyRunning = statuses.some((s) => s === "running")
  if (anyRunning) {
    return { status: "running", isComplete: false }
  }

  const allSuccess = statuses.every((s) => SUCCESS_RUN_STATUSES.has(s))
  if (allSuccess) {
    return { status: "success", isComplete: true }
  }

  const anyFailed = statuses.some((s) => FAILURE_RUN_STATUSES.has(s))
  const allTerminal = statuses.every((s) => TERMINAL_RUN_STATUSES.has(s))

  if (anyFailed) {
    // Fail fast when a run has definitively failed and no runs are still running.
    // Pending runs are typically blocked by DAG dependencies and will not recover
    // without an explicit retry/new run group.
    return { status: "failed", isComplete: true }
  }

  if (allTerminal) {
    return { status: "partial", isComplete: true }
  }

  return { status: "running", isComplete: false }
}

/**
 * Create a new run group.
 */
export async function createRunGroup(values: NewRunGroup): Promise<RunGroup> {
  return withDbSpan("insert", "run_groups", async () => {
    const rows = await db.insert(runGroups).values(values).returning()
    return rows[0]
  })
}

/**
 * Update a run group's status.
 */
export async function updateRunGroupStatus(
  runGroupId: string,
  status: RunStatus,
  extra?: {
    startedAt?: Date
    completedAt?: Date
  },
): Promise<void> {
  return withDbSpan("update", "run_groups", async () => {
    await db
      .update(runGroups)
      .set({ status, ...extra })
      .where(eq(runGroups.id, runGroupId))
  })
}

/**
 * Find a run group by ID.
 */
export async function findRunGroupById(runGroupId: string): Promise<RunGroup | undefined> {
  return withDbSpan("select", "run_groups", async () => {
    const rows = await db
      .select()
      .from(runGroups)
      .where(eq(runGroups.id, runGroupId))
      .limit(1)
    return rows[0]
  })
}

/**
 * Batch-load run groups by ID.
 */
export async function findRunGroupsByIds(runGroupIds: string[]): Promise<Map<string, RunGroup>> {
  if (runGroupIds.length === 0) {
    return new Map()
  }

  return withDbSpan("select", "run_groups", async () => {
    const rows = await db
      .select()
      .from(runGroups)
      .where(inArray(runGroups.id, runGroupIds))

    return new Map(rows.map((row) => [row.id, row]))
  })
}

/**
 * List run groups for a PR.
 */
export async function listRunGroupsForPr(
  orgId: string,
  repo: string,
  prNumber: number,
  limit = 20,
): Promise<RunGroup[]> {
  return withDbSpan("select", "run_groups", async () => {
    return db
      .select()
      .from(runGroups)
      .where(
        and(
          eq(runGroups.orgId, orgId),
          eq(runGroups.repo, repo),
          eq(runGroups.prNumber, prNumber),
        ),
      )
      .orderBy(desc(runGroups.createdAt))
      .limit(limit)
  })
}

/**
 * List run groups for a ref (environment).
 * @deprecated Use listRunGroupsForEnvironment instead
 */
export async function listRunGroupsForBranch(
  orgId: string,
  repo: string,
  ref: string,
  limit = 20,
): Promise<RunGroup[]> {
  return withDbSpan("select", "run_groups", async () => {
    return db
      .select()
      .from(runGroups)
      .where(
        and(
          eq(runGroups.orgId, orgId),
          eq(runGroups.repo, repo),
          // Match both NULL (push triggers) and 0 (manual reruns) for ref/env run groups
          or(isNull(runGroups.prNumber), eq(runGroups.prNumber, 0)),
          eq(runGroups.ref, ref),
        ),
      )
      .orderBy(desc(runGroups.createdAt))
      .limit(limit)
  })
}

/**
 * List run groups by environment name.
 * This is the unified query that works for both PR environments (e.g., "pr-123")
 * and named environments (e.g., "main", "staging").
 */
export async function listRunGroupsForEnvironment(
  orgId: string,
  repo: string,
  environmentName: string,
  limit = 20,
): Promise<RunGroup[]> {
  return withDbSpan("select", "run_groups", async () => {
    return db
      .select()
      .from(runGroups)
      .where(
        and(
          eq(runGroups.orgId, orgId),
          eq(runGroups.repo, repo),
          eq(runGroups.environmentName, environmentName),
        ),
      )
      .orderBy(desc(runGroups.createdAt))
      .limit(limit)
  })
}

/**
 * Get the latest run group for a PR.
 */
export async function getLatestRunGroupForPr(
  orgId: string,
  repo: string,
  prNumber: number,
): Promise<RunGroup | undefined> {
  return withDbSpan("select", "run_groups", async () => {
    const rows = await db
      .select()
      .from(runGroups)
      .where(
        and(
          eq(runGroups.orgId, orgId),
          eq(runGroups.repo, repo),
          eq(runGroups.prNumber, prNumber),
        ),
      )
      .orderBy(desc(runGroups.createdAt))
      .limit(1)
    return rows[0]
  })
}

/**
 * Get the latest run group for a ref (environment).
 * @deprecated Use getLatestRunGroupForEnvironment instead
 */
export async function getLatestRunGroupForBranch(
  orgId: string,
  repo: string,
  ref: string,
): Promise<RunGroup | undefined> {
  return withDbSpan("select", "run_groups", async () => {
    const rows = await db
      .select()
      .from(runGroups)
      .where(
        and(
          eq(runGroups.orgId, orgId),
          eq(runGroups.repo, repo),
          isNull(runGroups.prNumber),
          eq(runGroups.ref, ref),
        ),
      )
      .orderBy(desc(runGroups.createdAt))
      .limit(1)
    return rows[0]
  })
}

/**
 * Update the dependency graph for a run group.
 */
export async function updateRunGroupDependencyGraph(
  runGroupId: string,
  dependencyGraph: SerializableDependencyGraph,
): Promise<void> {
  return withDbSpan("update", "run_groups", async () => {
    await db
      .update(runGroups)
      .set({ dependencyGraph })
      .where(eq(runGroups.id, runGroupId))
  })
}

/**
 * Update the workspace S3 key for a run group.
 */
export async function updateRunGroupWorkspaceS3Key(
  runGroupId: string,
  workspaceS3Key: string,
): Promise<void> {
  return withDbSpan("update", "run_groups", async () => {
    await db
      .update(runGroups)
      .set({ workspaceS3Key })
      .where(eq(runGroups.id, runGroupId))
  })
}

/**
 * Compute the aggregate status for a run group based on its runs.
 * Call this when any run in the group completes.
 */
export async function recomputeRunGroupStatus(runGroupId: string): Promise<void> {
  return withDbSpan("update", "run_groups", async () => {
    // Get all runs in this group
    const runs = await db
      .select({ status: tfRuns.status })
      .from(tfRuns)
      .where(eq(tfRuns.runGroupId, runGroupId))

    if (runs.length === 0) return

    const statuses = runs.map((r) => r.status)
    const { status, isComplete } = deriveRunGroupStatusFromRunStatuses(statuses)
    const completedAt = isComplete ? new Date() : undefined

    await db
      .update(runGroups)
      .set({
        status,
        ...(completedAt ? { completedAt } : {}),
      })
      .where(eq(runGroups.id, runGroupId))
  })
}

/**
 * Get the latest dependency graph for each unique environment in an org.
 * Returns a map of environmentKey -> dependencyGraph.
 * environmentKey is "{repo}:{environmentName}" (e.g., "my-repo:pr-123" or "my-repo:main")
 */
export async function getLatestDependencyGraphsForOrg(
  orgId: string,
  repo?: string,
): Promise<Map<string, SerializableDependencyGraph>> {
  return withDbSpan("select", "run_groups", async () => {
    // Get latest run group per environment using a subquery
    // We use raw SQL for the DISTINCT ON functionality
    const query = db
      .select({
        repo: runGroups.repo,
        environmentName: runGroups.environmentName,
        dependencyGraph: runGroups.dependencyGraph,
      })
      .from(runGroups)
      .where(
        repo
          ? and(eq(runGroups.orgId, orgId), eq(runGroups.repo, repo))
          : eq(runGroups.orgId, orgId),
      )
      .orderBy(desc(runGroups.createdAt))

    const rows = await query

    // Build map, keeping only the first (latest) entry per environment
    const result = new Map<string, SerializableDependencyGraph>()
    const seen = new Set<string>()

    for (const row of rows) {
      if (!row.environmentName) continue
      const key = `${row.repo}:${row.environmentName}`
      if (seen.has(key)) continue
      seen.add(key)
      if (row.dependencyGraph) {
        result.set(key, row.dependencyGraph as SerializableDependencyGraph)
      }
    }

    return result
  })
}
