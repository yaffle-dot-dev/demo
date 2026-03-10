import { and, desc, eq, isNull } from "drizzle-orm"

import type { RunStatus } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { runGroups, tfRuns } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type RunGroup = typeof runGroups.$inferSelect
export type NewRunGroup = typeof runGroups.$inferInsert

export type RunGroupTrigger = "pr_opened" | "pr_sync" | "push" | "manual"

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
 * List run groups for a branch (environment).
 */
export async function listRunGroupsForBranch(
  orgId: string,
  repo: string,
  branch: string,
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
          isNull(runGroups.prNumber),
          eq(runGroups.branch, branch),
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
 * Get the latest run group for a branch (environment).
 */
export async function getLatestRunGroupForBranch(
  orgId: string,
  repo: string,
  branch: string,
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
          eq(runGroups.branch, branch),
        ),
      )
      .orderBy(desc(runGroups.createdAt))
      .limit(1)
    return rows[0]
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
    const allPending = statuses.every((s) => s === "pending")
    const allSuccess = statuses.every((s) => s === "success")
    const allComplete = statuses.every((s) => s === "success" || s === "failed" || s === "cancelled")
    const anyRunning = statuses.some((s) => s === "running")
    const anyFailed = statuses.some((s) => s === "failed")

    let newStatus: string
    let completedAt: Date | undefined

    if (allPending) {
      newStatus = "pending"
    } else if (anyRunning) {
      newStatus = "running"
    } else if (allComplete) {
      completedAt = new Date()
      if (allSuccess) {
        newStatus = "success"
      } else if (anyFailed) {
        newStatus = "failed"
      } else {
        newStatus = "partial" // Mix of success/cancelled
      }
    } else {
      newStatus = "running"
    }

    await db
      .update(runGroups)
      .set({
        status: newStatus,
        ...(completedAt ? { completedAt } : {}),
      })
      .where(eq(runGroups.id, runGroupId))
  })
}
