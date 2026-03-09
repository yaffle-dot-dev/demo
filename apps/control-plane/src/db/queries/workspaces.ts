import { and, desc, eq, gt, type SQL } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { workspaces } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type WorkspaceStatus = "active" | "destroying" | "archived"
/**
 * Workspace environment type.
 * - "preview": ephemeral workspace for a PR
 * - string: branch name for non-preview workspaces (e.g. "main", "staging")
 */
export type WorkspaceEnvironment = "preview" | string

export interface ListWorkspacesOptions {
  repo?: string
  environment?: WorkspaceEnvironment
  prNumber?: number
  status?: WorkspaceStatus
  limit?: number
  cursor?: string
}

/**
 * Find a workspace by its UUID.
 */
export async function findWorkspaceById(id: string): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find a workspace by org + name (the unique constraint).
 */
export async function findWorkspaceByName(
  orgId: string,
  name: string,
): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.name, name)))
      .limit(1)
    return rows[0]
  })
}

/**
 * List workspaces with optional filtering and cursor-based pagination.
 */
export async function listWorkspaces(
  orgId: string,
  opts: ListWorkspacesOptions = {},
): Promise<{ items: Workspace[]; nextCursor: string | null }> {
  return withDbSpan("select", "workspaces", async () => {
    const limit = Math.min(opts.limit ?? 50, 250)
    const conditions: SQL[] = [eq(workspaces.orgId, orgId)]

    if (opts.repo) {
      conditions.push(eq(workspaces.repo, opts.repo))
    }
    if (opts.environment) {
      conditions.push(eq(workspaces.environment, opts.environment))
    }
    if (opts.prNumber !== undefined) {
      conditions.push(eq(workspaces.prNumber, opts.prNumber))
    }
    if (opts.status) {
      conditions.push(eq(workspaces.status, opts.status))
    }
    if (opts.cursor) {
      conditions.push(gt(workspaces.createdAt, new Date(opts.cursor)))
    }

    const rows = await db
      .select()
      .from(workspaces)
      .where(and(...conditions))
      .orderBy(desc(workspaces.createdAt))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null

    return { items, nextCursor }
  })
}

/**
 * Create a new workspace.
 */
export async function createWorkspace(values: NewWorkspace): Promise<Workspace> {
  return withDbSpan("insert", "workspaces", async () => {
    const rows = await db.insert(workspaces).values(values).returning()
    return rows[0]
  })
}

/**
 * Upsert a workspace. On conflict (same org/name), update fields.
 */
export async function upsertWorkspace(values: NewWorkspace): Promise<Workspace> {
  return withDbSpan("upsert", "workspaces", async () => {
    const rows = await db
      .insert(workspaces)
      .values(values)
      .onConflictDoUpdate({
        target: [workspaces.orgId, workspaces.name],
        set: {
          repo: values.repo,
          workspacePath: values.workspacePath,
          branch: values.branch,
          terraformVersion: values.terraformVersion,
        },
      })
      .returning()
    return rows[0]
  })
}

/**
 * Update a workspace's status.
 */
export async function updateWorkspaceStatus(
  workspaceId: string,
  status: WorkspaceStatus,
): Promise<void> {
  return withDbSpan("update", "workspaces", async () => {
    await db.update(workspaces).set({ status }).where(eq(workspaces.id, workspaceId))
  })
}

/**
 * Lock a workspace. Returns the updated workspace if successful, undefined if already locked.
 */
export async function lockWorkspace(
  workspaceId: string,
  lockedBy: string,
  reason?: string,
): Promise<Workspace | undefined> {
  return withDbSpan("update", "workspaces", async () => {
    // Use a conditional update to atomically check and lock
    const rows = await db
      .update(workspaces)
      .set({
        locked: true,
        lockedBy,
        lockedAt: new Date(),
        lockReason: reason,
      })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.locked, false)))
      .returning()
    return rows[0]
  })
}

/**
 * Unlock a workspace. Only succeeds if the caller is the lock holder.
 */
export async function unlockWorkspace(
  workspaceId: string,
  lockedBy: string,
): Promise<Workspace | undefined> {
  return withDbSpan("update", "workspaces", async () => {
    const rows = await db
      .update(workspaces)
      .set({
        locked: false,
        lockedBy: null,
        lockedAt: null,
        lockReason: null,
      })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.lockedBy, lockedBy)))
      .returning()
    return rows[0]
  })
}

/**
 * Force unlock a workspace (admin operation).
 */
export async function forceUnlockWorkspace(workspaceId: string): Promise<Workspace | undefined> {
  return withDbSpan("update", "workspaces", async () => {
    const rows = await db
      .update(workspaces)
      .set({
        locked: false,
        lockedBy: null,
        lockedAt: null,
        lockReason: null,
      })
      .where(eq(workspaces.id, workspaceId))
      .returning()
    return rows[0]
  })
}

/**
 * Update the current state version ID for a workspace.
 */
export async function updateWorkspaceCurrentState(
  workspaceId: string,
  currentStateVersionId: string,
): Promise<void> {
  return withDbSpan("update", "workspaces", async () => {
    await db
      .update(workspaces)
      .set({ currentStateVersionId })
      .where(eq(workspaces.id, workspaceId))
  })
}

/**
 * Build a workspace name from components.
 * Format: {environment}-{identifier}-{workspace_path_slug}
 */
export function buildWorkspaceName(
  environment: WorkspaceEnvironment,
  identifier: string,
  workspacePath: string,
): string {
  const pathSlug = workspacePath.replace(/\//g, "-").replace(/[^a-z0-9-]/gi, "")
  return `${environment}-${identifier}-${pathSlug}`
}

/**
 * Build a preview workspace name.
 */
export function buildPreviewWorkspaceName(prNumber: number, workspacePath: string): string {
  return buildWorkspaceName("preview", `pr-${prNumber}`, workspacePath)
}

/**
 * Build a branch workspace name (non-preview).
 * Uses the branch name as both the environment and identifier.
 */
export function buildBranchWorkspaceName(branch: string, workspacePath: string): string {
  return buildWorkspaceName(branch, branch, workspacePath)
}

/**
 * Find all workspaces for a PR.
 */
export async function findWorkspacesByPr(
  orgId: string,
  repo: string,
  prNumber: number,
): Promise<Workspace[]> {
  return withDbSpan("select", "workspaces", async () => {
    return db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.repo, repo),
          eq(workspaces.prNumber, prNumber),
          eq(workspaces.environment, "preview"),
        ),
      )
  })
}

/**
 * Archive a workspace (soft delete).
 * Sets status to 'archived' and clears lock.
 */
export async function archiveWorkspace(workspaceId: string): Promise<Workspace | undefined> {
  return withDbSpan("update", "workspaces", async () => {
    const rows = await db
      .update(workspaces)
      .set({
        status: "archived",
        locked: false,
        lockedBy: null,
        lockedAt: null,
        lockReason: null,
      })
      .where(eq(workspaces.id, workspaceId))
      .returning()
    return rows[0]
  })
}

/**
 * Find all preview workspaces that are in a failed state (for admin cleanup).
 */
export async function findFailedWorkspaces(
  orgId: string,
): Promise<Workspace[]> {
  return withDbSpan("select", "workspaces", async () => {
    return db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.environment, "preview"),
          // Using status check - workspaces can be in various failed states
          // We consider locked but inactive workspaces as potentially failed
        ),
      )
      .orderBy(desc(workspaces.createdAt))
  })
}

/**
 * Delete a workspace.
 * Used for cleanup in tests.
 */
export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  return withDbSpan("delete", "workspaces", async () => {
    const rows = await db
      .delete(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .returning({ id: workspaces.id })
    return rows.length > 0
  })
}

/**
 * Find a workspace by org, workspace path, and environment.
 * Used by the module registry to look up workspaces.
 *
 * The workspace path is stored in the `workspacePath` column.
 * For non-preview workspaces, environment is the branch name (e.g. "main").
 */
export async function findWorkspaceByPath(
  orgId: string,
  workspacePath: string,
  environment: WorkspaceEnvironment,
): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.workspacePath, workspacePath),
          eq(workspaces.environment, environment),
          eq(workspaces.status, "active"),
        ),
      )
      .limit(1)
    return rows[0]
  })
}

/**
 * Find a non-preview workspace by org and workspace path.
 * Returns the "main" environment workspace if it exists, otherwise the first
 * active workspace that is not a preview.
 * Used for module resolution when the caller doesn't know the branch name.
 */
export async function findNonPreviewWorkspace(
  orgId: string,
  workspacePath: string,
): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.workspacePath, workspacePath),
          // Non-preview means environment is NOT "preview"
          // In SQL: environment != 'preview'
        ),
      )
      .limit(10) // Get a few to filter

    // Filter out preview workspaces
    const nonPreviewRows = rows.filter(
      (row) => row.environment !== "preview" && row.status === "active",
    )

    // Prefer "main" environment, then fall back to first found
    return nonPreviewRows.find((row) => row.environment === "main") ?? nonPreviewRows[0]
  })
}

/**
 * Find a preview workspace by org, workspace path, and PR number.
 * Used by the module registry for preview-aware resolution.
 */
export async function findPreviewWorkspace(
  orgId: string,
  workspacePath: string,
  prNumber: number,
): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.workspacePath, workspacePath),
          eq(workspaces.environment, "preview"),
          eq(workspaces.prNumber, prNumber),
          eq(workspaces.status, "active"),
        ),
      )
      .limit(1)
    return rows[0]
  })
}
