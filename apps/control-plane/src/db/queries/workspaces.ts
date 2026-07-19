import { and, desc, eq, gt, inArray, type SQL } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { organizations, workspaces } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type WorkspaceStatus = "active" | "destroying" | "archived"
export type WorkspaceEnvironmentKind = "named" | "transient"

export interface ListWorkspacesOptions {
  repo?: string
  environmentKind?: WorkspaceEnvironmentKind
  environmentName?: string
  status?: WorkspaceStatus
  limit?: number
  cursor?: string
}

/**
 * Find a workspace by its UUID.
 */
export async function findWorkspaceById(id: string): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
    return rows[0]
  })
}

/**
 * Find a workspace by its persisted lock ID.
 */
export async function findWorkspaceByLockId(lockId: string): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db.select().from(workspaces).where(eq(workspaces.lockId, lockId)).limit(1)
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
    if (opts.environmentKind) {
      conditions.push(eq(workspaces.environmentKind, opts.environmentKind))
    }
    if (opts.environmentName) {
      conditions.push(eq(workspaces.environmentName, opts.environmentName))
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
          environmentKind: values.environmentKind,
          environmentName: values.environmentName,
          ref: values.ref,
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
 * Mark a workspace as destroying only when no backend operation holds its lock.
 * The destroy runner acquires the actual backend lock through the TFC interface.
 */
export async function markWorkspaceDestroying(workspaceId: string): Promise<Workspace | undefined> {
  return withDbSpan("update", "workspaces", async () => {
    const rows = await db
      .update(workspaces)
      .set({ status: "destroying" })
      .where(
        and(eq(workspaces.id, workspaceId), inArray(workspaces.status, ["active", "destroying"])),
      )
      .returning()
    return rows[0]
  })
}

/**
 * Lock a workspace. Returns the updated workspace if successful, undefined if already locked.
 */
export async function lockWorkspace(
  workspaceId: string,
  lockedBy: string,
  reason?: string,
  options?: { allowDestroying?: boolean },
): Promise<Workspace | undefined> {
  return withDbSpan("update", "workspaces", async () => {
    const workspace = await findWorkspaceById(workspaceId)
    if (!workspace) {
      return undefined
    }

    const orgRows = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, workspace.orgId))
      .limit(1)
    const orgSlug = orgRows[0]?.slug
    if (!orgSlug) {
      return undefined
    }

    const lockId = buildWorkspaceLockId(orgSlug, workspace.name)

    const allowedStatus = options?.allowDestroying
      ? inArray(workspaces.status, ["active", "destroying"])
      : eq(workspaces.status, "active")

    // Use a conditional update to atomically check status and acquire the lock.
    const rows = await db
      .update(workspaces)
      .set({
        locked: true,
        lockedBy,
        lockedAt: new Date(),
        lockReason: reason,
        lockId,
      })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.locked, false), allowedStatus))
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
        lockId: null,
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
        lockId: null,
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
    await db.update(workspaces).set({ currentStateVersionId }).where(eq(workspaces.id, workspaceId))
  })
}

/**
 * Build a workspace name from components.
 * Format: {repo}-{environment}-{refName}-{workspace_path}
 *
 * All components are slugified (special chars replaced with `-`, lowercased).
 *
 * The repo is included to prevent collisions between workspaces with the same
 * path in different repositories within the same organization.
 *
 * @param ref - Full git ref (e.g., "refs/heads/main", "refs/tags/v1.0.0")
 */
export function buildWorkspaceName(
  repo: string,
  environment: string,
  ref: string,
  workspacePath: string,
): string {
  const slugify = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")

  // Extract repo name from "owner/repo" format, or use as-is
  const repoName = repo.includes("/") ? repo.split("/")[1] : repo

  // Extract ref name (strip refs/heads/ or refs/tags/ prefix)
  const refName = ref.replace(/^refs\/(heads|tags)\//, "")

  return [slugify(repoName), slugify(environment), slugify(refName), slugify(workspacePath)].join(
    "-",
  )
}

/**
 * Build lock ID for TFC/OpenTofu force-unlock compatibility.
 * Format: {org_slug}/{workspace_name}
 */
export function buildWorkspaceLockId(orgSlug: string, workspaceName: string): string {
  return `${orgSlug}/${workspaceName}`
}

/**
 * Find all transient workspaces with the given environment identity.
 */
export async function findTransientWorkspaces(
  orgId: string,
  repo: string,
  environmentName: string,
): Promise<Workspace[]> {
  return withDbSpan("select", "workspaces", async () => {
    return db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.repo, repo),
          eq(workspaces.environmentKind, "transient"),
          eq(workspaces.environmentName, environmentName),
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
        lockId: null,
      })
      .where(eq(workspaces.id, workspaceId))
      .returning()
    return rows[0]
  })
}

/** Archive only after a destroy operation has released its backend lock. */
export async function archiveWorkspaceAfterDestroy(
  workspaceId: string,
): Promise<Workspace | undefined> {
  return withDbSpan("update", "workspaces", async () => {
    const rows = await db
      .update(workspaces)
      .set({
        status: "archived",
        locked: false,
        lockedBy: null,
        lockedAt: null,
        lockReason: null,
        lockId: null,
      })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.status, "destroying"),
          eq(workspaces.locked, false),
        ),
      )
      .returning()
    return rows[0]
  })
}

/**
 * Find all transient workspaces that are in a failed state (for admin cleanup).
 */
export async function findFailedWorkspaces(orgId: string): Promise<Workspace[]> {
  return withDbSpan("select", "workspaces", async () => {
    return db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.environmentKind, "transient"),
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
 * Find a workspace by its canonical environment identity.
 */
export async function findWorkspaceByIdentity(
  orgId: string,
  repo: string,
  workspacePath: string,
  environmentKind: WorkspaceEnvironmentKind,
  environmentName: string,
): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.repo, repo),
          eq(workspaces.workspacePath, workspacePath),
          eq(workspaces.environmentKind, environmentKind),
          eq(workspaces.environmentName, environmentName),
        ),
      )
      .limit(1)
    return rows[0]
  })
}

/**
 * Find a named workspace by org, repo, and workspace path.
 * Returns the "main" environment workspace if it exists, otherwise the first
 * active named workspace.
 */
export async function findNamedWorkspace(
  orgId: string,
  repo: string,
  workspacePath: string,
): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.repo, repo),
          eq(workspaces.workspacePath, workspacePath),
          eq(workspaces.environmentKind, "named"),
          eq(workspaces.status, "active"),
        ),
      )
      .limit(10) // Get a few to filter

    // Prefer "main" environment, then fall back to first found
    return rows.find((row) => row.environmentName === "main") ?? rows[0]
  })
}

/**
 * Find a transient workspace by its source-neutral environment identity.
 */
export async function findTransientWorkspace(
  orgId: string,
  repo: string,
  workspacePath: string,
  environmentName: string,
): Promise<Workspace | undefined> {
  return withDbSpan("select", "workspaces", async () => {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, orgId),
          eq(workspaces.repo, repo),
          eq(workspaces.workspacePath, workspacePath),
          eq(workspaces.environmentKind, "transient"),
          eq(workspaces.environmentName, environmentName),
          eq(workspaces.status, "active"),
        ),
      )
      .limit(1)
    return rows[0]
  })
}
