import { and, desc, eq, gt, type SQL } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { stateVersions, workspaces } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type StateVersion = typeof stateVersions.$inferSelect
export type NewStateVersion = typeof stateVersions.$inferInsert
export type StateVersionStatus = "pending" | "finalized" | "discarded"

export interface ListStateVersionsOptions {
  status?: StateVersionStatus
  limit?: number
  cursor?: string
}

/**
 * Find a state version by its UUID.
 */
export async function findStateVersionById(id: string): Promise<StateVersion | undefined> {
  return withDbSpan("select", "state_versions", async () => {
    const rows = await db
      .select()
      .from(stateVersions)
      .where(eq(stateVersions.id, id))
      .limit(1)
    return rows[0]
  })
}

/**
 * Get the current (latest finalized) state version for a workspace.
 */
export async function getCurrentStateVersion(
  workspaceId: string,
): Promise<StateVersion | undefined> {
  return withDbSpan("select", "state_versions", async () => {
    // Join with workspaces to get the current_state_version_id
    const rows = await db
      .select({ stateVersion: stateVersions })
      .from(workspaces)
      .innerJoin(stateVersions, eq(workspaces.currentStateVersionId, stateVersions.id))
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    return rows[0]?.stateVersion
  })
}

/**
 * Get the latest state version by serial (regardless of status).
 */
export async function getLatestStateVersion(
  workspaceId: string,
): Promise<StateVersion | undefined> {
  return withDbSpan("select", "state_versions", async () => {
    const rows = await db
      .select()
      .from(stateVersions)
      .where(eq(stateVersions.workspaceId, workspaceId))
      .orderBy(desc(stateVersions.serial))
      .limit(1)
    return rows[0]
  })
}

/**
 * List state versions for a workspace with optional filtering.
 */
export async function listStateVersions(
  workspaceId: string,
  opts: ListStateVersionsOptions = {},
): Promise<{ items: StateVersion[]; nextCursor: string | null }> {
  return withDbSpan("select", "state_versions", async () => {
    const limit = Math.min(opts.limit ?? 50, 250)
    const conditions: SQL[] = [eq(stateVersions.workspaceId, workspaceId)]

    if (opts.status) {
      conditions.push(eq(stateVersions.status, opts.status))
    }
    if (opts.cursor) {
      conditions.push(gt(stateVersions.createdAt, new Date(opts.cursor)))
    }

    const rows = await db
      .select()
      .from(stateVersions)
      .where(and(...conditions))
      .orderBy(desc(stateVersions.serial))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null

    return { items, nextCursor }
  })
}

/**
 * Create a new state version (in pending status).
 */
export async function createStateVersion(values: NewStateVersion): Promise<StateVersion> {
  return withDbSpan("insert", "state_versions", async () => {
    const rows = await db.insert(stateVersions).values(values).returning()
    return rows[0]
  })
}

/**
 * Finalize a state version (mark as uploaded and ready).
 * Optionally stores outputs extracted from the state file.
 */
export async function finalizeStateVersion(
  stateVersionId: string,
  terraformVersion?: string,
  outputs?: Record<string, unknown>,
): Promise<StateVersion | undefined> {
  return withDbSpan("update", "state_versions", async () => {
    const rows = await db
      .update(stateVersions)
      .set({
        status: "finalized",
        terraformVersion,
        outputs: outputs ?? null,
      })
      .where(and(eq(stateVersions.id, stateVersionId), eq(stateVersions.status, "pending")))
      .returning()
    return rows[0]
  })
}

/**
 * Update a state version's processed resources and outputs.
 */
export async function updateStateVersionResources(
  stateVersionId: string,
  resources: unknown,
  outputs: unknown,
): Promise<void> {
  return withDbSpan("update", "state_versions", async () => {
    await db
      .update(stateVersions)
      .set({
        resources,
        outputs,
        resourcesProcessed: true,
      })
      .where(eq(stateVersions.id, stateVersionId))
  })
}

/**
 * Discard a pending state version (e.g., upload failed or expired).
 */
export async function discardStateVersion(stateVersionId: string): Promise<void> {
  return withDbSpan("update", "state_versions", async () => {
    await db
      .update(stateVersions)
      .set({ status: "discarded" })
      .where(and(eq(stateVersions.id, stateVersionId), eq(stateVersions.status, "pending")))
  })
}

/**
 * Build an S3 key for a state version.
 * Format: {workspace_id}/v{serial}.tfstate
 */
export function buildS3Key(workspaceId: string, serial: number): string {
  return `${workspaceId}/v${serial}.tfstate`
}

/**
 * List finalized state versions for module registry.
 * Returns versions in descending serial order (newest first).
 */
export async function listStateVersionsForModule(
  workspaceId: string,
  limit: number = 50,
): Promise<StateVersion[]> {
  return withDbSpan("select", "state_versions", async () => {
    return db
      .select()
      .from(stateVersions)
      .where(
        and(
          eq(stateVersions.workspaceId, workspaceId),
          eq(stateVersions.status, "finalized"),
        ),
      )
      .orderBy(desc(stateVersions.serial))
      .limit(limit)
  })
}

/**
 * Find a specific state version by workspace ID and serial number.
 */
export async function findStateVersionBySerial(
  workspaceId: string,
  serial: number,
): Promise<StateVersion | undefined> {
  return withDbSpan("select", "state_versions", async () => {
    const rows = await db
      .select()
      .from(stateVersions)
      .where(
        and(
          eq(stateVersions.workspaceId, workspaceId),
          eq(stateVersions.serial, serial),
        ),
      )
      .limit(1)
    return rows[0]
  })
}
