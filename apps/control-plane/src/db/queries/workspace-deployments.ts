import { and, arrayContains, desc, eq, gt, notInArray, sql, type SQL } from "drizzle-orm"

import type { PreviewStatus } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { workspaceDeployments } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { events } from "../../lib/events.ts"
import type { EnvironmentKind } from "../../lib/config-toml.ts"

export type WorkspaceDeployment = typeof workspaceDeployments.$inferSelect
export type NewWorkspaceDeployment = typeof workspaceDeployments.$inferInsert

export interface ListDeploymentsOptions {
  repo?: string
  status?: PreviewStatus
  environmentKind?: EnvironmentKind
  environmentName?: string
  /** @deprecated Use environmentName with "pr-{number}" format */
  prNumber?: number
  limit?: number
  cursor?: string
}

/**
 * Find a deployment by its UUID.
 */
export async function findDeploymentById(
  id: string,
): Promise<WorkspaceDeployment | undefined> {
  return withDbSpan("select", "workspace_deployments", async () => {
    const rows = await db
      .select()
      .from(workspaceDeployments)
      .where(eq(workspaceDeployments.id, id))
      .limit(1)
    return rows[0]
  })
}



/**
 * List deployments with optional filtering and cursor-based pagination.
 * Cursor is the `createdAt` timestamp of the last item from the previous page.
 */
export async function listDeployments(
  orgId: string,
  opts: ListDeploymentsOptions = {},
): Promise<{ items: WorkspaceDeployment[]; nextCursor: string | null }> {
  return withDbSpan("select", "workspace_deployments", async () => {
    const limit = Math.min(opts.limit ?? 50, 250)
    const conditions: SQL[] = [eq(workspaceDeployments.orgId, orgId)]

    if (opts.repo) {
      conditions.push(eq(workspaceDeployments.repo, opts.repo))
    }
    if (opts.status) {
      conditions.push(eq(workspaceDeployments.status, opts.status))
    }
    if (opts.environmentKind) {
      conditions.push(eq(workspaceDeployments.environmentKind, opts.environmentKind))
    }
    if (opts.environmentName) {
      conditions.push(eq(workspaceDeployments.environmentName, opts.environmentName))
    }
    // Support legacy prNumber filtering - filter by the prNumber column directly
    if (opts.prNumber !== undefined) {
      if (opts.prNumber > 0) {
        conditions.push(eq(workspaceDeployments.prNumber, opts.prNumber))
      } else {
        // prNumber=0 means named environments
        conditions.push(eq(workspaceDeployments.environmentKind, "named"))
      }
    }
    if (opts.cursor) {
      conditions.push(gt(workspaceDeployments.createdAt, new Date(opts.cursor)))
    }

    const rows = await db
      .select()
      .from(workspaceDeployments)
      .where(and(...conditions))
      .orderBy(desc(workspaceDeployments.createdAt))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null

    return { items, nextCursor }
  })
}



/**
 * Find a deployment by org + repo + environment name + workspace path.
 * This is the new canonical lookup method replacing findPreview.
 */
export async function findDeployment(
  orgId: string,
  repo: string,
  environmentName: string,
  workspacePath: string,
): Promise<WorkspaceDeployment | undefined> {
  return withDbSpan("select", "workspace_deployments", async () => {
    const rows = await db
      .select()
      .from(workspaceDeployments)
      .where(
        and(
          eq(workspaceDeployments.orgId, orgId),
          eq(workspaceDeployments.repo, repo),
          eq(workspaceDeployments.environmentName, environmentName),
          eq(workspaceDeployments.workspacePath, workspacePath),
        ),
      )
      .limit(1)
    return rows[0]
  })
}

/**
 * @deprecated Use findDeployment with environmentName instead
 * Find a deployment by org + repo + PR number + workspace path.
 */
export async function findPreview(
  orgId: string,
  repo: string,
  prNumber: number,
  workspacePath: string,
): Promise<WorkspaceDeployment | undefined> {
  const environmentName = prNumber > 0 ? `pr-${prNumber}` : undefined
  if (!environmentName) {
    // For prNumber=0, we need to look up by workspace path in named environments
    // This is ambiguous without branch info, so we fall back to a direct query
    return withDbSpan("select", "workspace_deployments", async () => {
      const rows = await db
        .select()
        .from(workspaceDeployments)
        .where(
          and(
            eq(workspaceDeployments.orgId, orgId),
            eq(workspaceDeployments.repo, repo),
            eq(workspaceDeployments.environmentKind, "named"),
            eq(workspaceDeployments.workspacePath, workspacePath),
          ),
        )
        .limit(1)
      return rows[0]
    })
  }
  return findDeployment(orgId, repo, environmentName, workspacePath)
}

/**
 * Upsert a deployment. On conflict (same org/repo/env/workspace), update the head SHA,
 * ref, and reset status to pending.
 */
export async function upsertDeployment(values: NewWorkspaceDeployment): Promise<WorkspaceDeployment> {
  return withDbSpan("upsert", "workspace_deployments", async () => {
    const rows = await db
      .insert(workspaceDeployments)
      .values(values)
      .onConflictDoUpdate({
        target: [
          workspaceDeployments.orgId,
          workspaceDeployments.repo,
          workspaceDeployments.environmentName,
          workspaceDeployments.workspacePath,
        ],
        set: {
          headSha: values.headSha,
          ref: values.ref,
          installationId: values.installationId,
          authorGithubId: values.authorGithubId,
          authorLogin: values.authorLogin,
          requireApproval: values.requireApproval,
          approvers: values.approvers,
          runGroupId: values.runGroupId,
          prNumber: values.prNumber,
          status: "pending",
          // Reset DAG tracking for new run - upstreams will be set by webhook handler,
          // completedUpstreams must start empty to properly track upstream completion
          upstreamIds: values.upstreamIds,
          completedUpstreams: [],
        },
      })
      .returning()

    const deployment = rows[0]
    // Emit event so SSE streams pick up the new headSha
    events.emitDeploymentUpdate(
      deployment.id,
      deployment.orgId,
      deployment.repo,
      deployment.environmentKind as EnvironmentKind,
      deployment.environmentName,
    )
    return deployment
  })
}



/**
 * Update a deployment's status.
 */
export async function updateDeploymentStatus(
  deploymentId: string,
  status: PreviewStatus,
): Promise<void> {
  return withDbSpan("update", "workspace_deployments", async () => {
    const updated = await db
      .update(workspaceDeployments)
      .set({ status })
      .where(eq(workspaceDeployments.id, deploymentId))
      .returning({
        orgId: workspaceDeployments.orgId,
        repo: workspaceDeployments.repo,
        environmentKind: workspaceDeployments.environmentKind,
        environmentName: workspaceDeployments.environmentName,
      })
    if (updated.length > 0) {
      const { orgId, repo, environmentKind, environmentName } = updated[0]
      events.emitDeploymentUpdate(deploymentId, orgId, repo, environmentKind as EnvironmentKind, environmentName)
    }
  })
}



/**
 * Update a deployment's head SHA (on synchronize events).
 */
export async function updateDeploymentHead(
  deploymentId: string,
  headSha: string,
): Promise<void> {
  return withDbSpan("update", "workspace_deployments", async () => {
    const updated = await db
      .update(workspaceDeployments)
      .set({ headSha, status: "pending" as PreviewStatus })
      .where(eq(workspaceDeployments.id, deploymentId))
      .returning({
        orgId: workspaceDeployments.orgId,
        repo: workspaceDeployments.repo,
        environmentKind: workspaceDeployments.environmentKind,
        environmentName: workspaceDeployments.environmentName,
      })
    if (updated.length > 0) {
      const { orgId, repo, environmentKind, environmentName } = updated[0]
      events.emitDeploymentUpdate(deploymentId, orgId, repo, environmentKind as EnvironmentKind, environmentName)
    }
  })
}



/**
 * Find all deployments for an environment (all workspaces).
 */
export async function findDeploymentsByEnvironment(
  orgId: string,
  repo: string,
  environmentName: string,
): Promise<WorkspaceDeployment[]> {
  return withDbSpan("select", "workspace_deployments", async () => {
    return db
      .select()
      .from(workspaceDeployments)
      .where(
        and(
          eq(workspaceDeployments.orgId, orgId),
          eq(workspaceDeployments.repo, repo),
          eq(workspaceDeployments.environmentName, environmentName),
        ),
      )
      .orderBy(workspaceDeployments.workspacePath)
  })
}

/**
 * Mark production deployments as destroyed if they're no longer in the config.
 * This handles cases where workspaces are removed from yaffle.toml.
 */
export async function markRemovedWorkspacesDestroyed(
  orgId: string,
  repo: string,
  environmentName: string,
  headSha: string,
  activeWorkspacePaths: string[],
): Promise<number> {
  return withDbSpan("update", "workspace_deployments", async () => {
    if (activeWorkspacePaths.length === 0) {
      // If no workspaces are active, mark all deployments for this environment as destroyed
      const result = await db
        .update(workspaceDeployments)
        .set({ status: "destroyed" as PreviewStatus, headSha })
        .where(
          and(
            eq(workspaceDeployments.orgId, orgId),
            eq(workspaceDeployments.repo, repo),
            eq(workspaceDeployments.environmentName, environmentName),
            eq(workspaceDeployments.environmentKind, "named"), // Only named environments
          ),
        )
        .returning({ id: workspaceDeployments.id })
      return result.length
    }

    const result = await db
      .update(workspaceDeployments)
      .set({ status: "destroyed" as PreviewStatus, headSha })
      .where(
        and(
          eq(workspaceDeployments.orgId, orgId),
          eq(workspaceDeployments.repo, repo),
          eq(workspaceDeployments.environmentName, environmentName),
          eq(workspaceDeployments.environmentKind, "named"),
          notInArray(workspaceDeployments.workspacePath, activeWorkspacePaths),
        ),
      )
      .returning({ id: workspaceDeployments.id })
    return result.length
  })
}

// =============================================================================
// DAG Coordination
// =============================================================================

/**
 * Set the upstream dependencies for a deployment.
 * Called when creating/updating deployments during webhook processing.
 */
export async function setDeploymentUpstreams(
  deploymentId: string,
  upstreamIds: string[],
): Promise<void> {
  return withDbSpan("update", "workspace_deployments", async () => {
    await db
      .update(workspaceDeployments)
      .set({ upstreamIds })
      .where(eq(workspaceDeployments.id, deploymentId))
  })
}

/**
 * Add a completed upstream to a deployment's completed_upstreams set.
 * Returns the updated deployment so we can check if it's now ready.
 */
export async function addCompletedUpstream(
  deploymentId: string,
  completedUpstreamId: string,
): Promise<WorkspaceDeployment | undefined> {
  return withDbSpan("update", "workspace_deployments", async () => {
    // Use array_append to add the ID if not already present
    const rows = await db
      .update(workspaceDeployments)
      .set({
        completedUpstreams: sql`
          CASE
            WHEN ${completedUpstreamId} = ANY(${workspaceDeployments.completedUpstreams})
            THEN ${workspaceDeployments.completedUpstreams}
            ELSE array_append(${workspaceDeployments.completedUpstreams}, ${completedUpstreamId})
          END
        `,
      })
      .where(eq(workspaceDeployments.id, deploymentId))
      .returning()

    const deployment = rows[0]
    if (deployment) {
      events.emitDeploymentUpdate(
        deployment.id,
        deployment.orgId,
        deployment.repo,
        deployment.environmentKind as EnvironmentKind,
        deployment.environmentName,
      )
    }
    return deployment
  })
}

/**
 * Check if a deployment is ready to execute (all upstreams completed).
 */
export function isDeploymentReady(deployment: WorkspaceDeployment): boolean {
  const upstreams = new Set(deployment.upstreamIds)
  const completed = new Set(deployment.completedUpstreams)

  // All upstream IDs must be in the completed set
  for (const upstreamId of upstreams) {
    if (!completed.has(upstreamId)) {
      return false
    }
  }
  return true
}

/**
 * Result of attempting to mark an upstream as complete.
 */
export interface UpstreamCompleteResult {
  /** The updated deployment */
  deployment: WorkspaceDeployment
  /** Whether this call won the race to queue the downstream job */
  shouldQueueJob: boolean
}

/**
 * Add a completed upstream to a deployment and atomically determine if we should queue a job.
 * 
 * This function prevents race conditions where multiple upstreams complete simultaneously
 * and both try to queue a plan job for the same downstream deployment.
 * 
 * The atomic guarantee comes from using a CAS (compare-and-swap) pattern:
 * 1. Add the completed upstream ID to the array
 * 2. Check if all upstreams are now complete
 * 3. If ready, atomically transition status from "pending" to "planning" 
 *    (only one caller can win this transition)
 * 4. The winner is responsible for creating the job
 */
export async function addCompletedUpstreamAtomic(
  deploymentId: string,
  completedUpstreamId: string,
): Promise<UpstreamCompleteResult | undefined> {
  return withDbSpan("update", "workspace_deployments", async () => {
    // Step 1: Add the completed upstream (idempotent)
    const rows = await db
      .update(workspaceDeployments)
      .set({
        completedUpstreams: sql`
          CASE
            WHEN ${completedUpstreamId} = ANY(${workspaceDeployments.completedUpstreams})
            THEN ${workspaceDeployments.completedUpstreams}
            ELSE array_append(${workspaceDeployments.completedUpstreams}, ${completedUpstreamId})
          END
        `,
      })
      .where(eq(workspaceDeployments.id, deploymentId))
      .returning()

    const deployment = rows[0]
    if (!deployment) {
      return undefined
    }

    // Emit update event
    events.emitDeploymentUpdate(
      deployment.id,
      deployment.orgId,
      deployment.repo,
      deployment.environmentKind as EnvironmentKind,
      deployment.environmentName,
    )

    // Step 2: Check if deployment is now ready
    if (!isDeploymentReady(deployment)) {
      return { deployment, shouldQueueJob: false }
    }

    // Step 3: If ready and pending, atomically claim the right to queue
    // This is a CAS operation: only transition if status is still "pending"
    if (deployment.status === "pending") {
      const claimed = await db
        .update(workspaceDeployments)
        .set({ status: "planning" })
        .where(
          and(
            eq(workspaceDeployments.id, deploymentId),
            eq(workspaceDeployments.status, "pending"),
          ),
        )
        .returning()

      if (claimed.length > 0) {
        // We won the race - emit update and signal to create job
        events.emitDeploymentUpdate(
          claimed[0].id,
          claimed[0].orgId,
          claimed[0].repo,
          claimed[0].environmentKind as EnvironmentKind,
          claimed[0].environmentName,
        )
        return { deployment: claimed[0], shouldQueueJob: true }
      }
      // Someone else won the race - they'll create the job
      return { deployment, shouldQueueJob: false }
    }

    // Status wasn't "pending" (maybe already planning/ready/etc)
    return { deployment, shouldQueueJob: false }
  })
}

/**
 * Atomically claim the right to queue a destroy job for an upstream deployment.
 * 
 * This is used when a downstream completes its destroy - we need to check if
 * all downstreams of the upstream are now destroyed, and if so, queue the
 * upstream's destroy job.
 * 
 * The race condition is: multiple downstreams complete destroy simultaneously,
 * both check that all downstreams are destroyed, both try to queue. This function
 * uses a CAS pattern to ensure only one wins.
 * 
 * @returns true if this call won the race and should create the destroy job
 */
export async function claimDestroyJobForUpstream(
  upstreamId: string,
): Promise<{ claimed: boolean; deployment?: WorkspaceDeployment }> {
  return withDbSpan("update", "workspace_deployments", async () => {
    // Atomically transition from "pending" to "destroying"
    // Only one caller can win this transition
    const claimed = await db
      .update(workspaceDeployments)
      .set({ status: "destroying" })
      .where(
        and(
          eq(workspaceDeployments.id, upstreamId),
          eq(workspaceDeployments.status, "pending"),
        ),
      )
      .returning()

    if (claimed.length > 0) {
      events.emitDeploymentUpdate(
        claimed[0].id,
        claimed[0].orgId,
        claimed[0].repo,
        claimed[0].environmentKind as EnvironmentKind,
        claimed[0].environmentName,
      )
      return { claimed: true, deployment: claimed[0] }
    }

    return { claimed: false }
  })
}

/**
 * Find all downstream deployments that depend on a given deployment.
 * These are deployments where upstream_ids contains the given deployment's ID.
 */
export async function findDownstreamDeployments(
  deploymentId: string,
): Promise<WorkspaceDeployment[]> {
  return withDbSpan("select", "workspace_deployments", async () => {
    return db
      .select()
      .from(workspaceDeployments)
      .where(arrayContains(workspaceDeployments.upstreamIds, [deploymentId]))
  })
}

/**
 * Find all deployments in a run group.
 */
export async function findDeploymentsByRunGroup(
  runGroupId: string,
): Promise<WorkspaceDeployment[]> {
  return withDbSpan("select", "workspace_deployments", async () => {
    return db
      .select()
      .from(workspaceDeployments)
      .where(eq(workspaceDeployments.runGroupId, runGroupId))
      .orderBy(workspaceDeployments.workspacePath)
  })
}

/**
 * Mark a deployment as skipped (due to upstream failure).
 */
export async function markDeploymentSkipped(
  deploymentId: string,
  _reason: string, // Kept for logging/debugging purposes
): Promise<void> {
  return withDbSpan("update", "workspace_deployments", async () => {
    const updated = await db
      .update(workspaceDeployments)
      .set({
        status: "failed" as PreviewStatus, // "skipped" maps to "failed" status with reason
        completedAt: new Date(),
      })
      .where(eq(workspaceDeployments.id, deploymentId))
      .returning({
        orgId: workspaceDeployments.orgId,
        repo: workspaceDeployments.repo,
        environmentKind: workspaceDeployments.environmentKind,
        environmentName: workspaceDeployments.environmentName,
      })

    if (updated.length > 0) {
      const { orgId, repo, environmentKind, environmentName } = updated[0]
      events.emitDeploymentUpdate(deploymentId, orgId, repo, environmentKind as EnvironmentKind, environmentName)
    }
  })
}

/**
 * Record approval on a deployment.
 */
export async function recordDeploymentApproval(
  deploymentId: string,
  approvedBy: string,
): Promise<void> {
  return withDbSpan("update", "workspace_deployments", async () => {
    const updated = await db
      .update(workspaceDeployments)
      .set({
        approvedAt: new Date(),
        approvedBy,
      })
      .where(eq(workspaceDeployments.id, deploymentId))
      .returning({
        orgId: workspaceDeployments.orgId,
        repo: workspaceDeployments.repo,
        environmentKind: workspaceDeployments.environmentKind,
        environmentName: workspaceDeployments.environmentName,
      })

    if (updated.length > 0) {
      const { orgId, repo, environmentKind, environmentName } = updated[0]
      events.emitDeploymentUpdate(deploymentId, orgId, repo, environmentKind as EnvironmentKind, environmentName)
    }
  })
}

/**
 * Update a deployment's run group and reset status to pending.
 * Used when manually re-running a deployment.
 */
export async function updateDeploymentRunGroup(
  deploymentId: string,
  runGroupId: string,
): Promise<WorkspaceDeployment | undefined> {
  return withDbSpan("update", "workspace_deployments", async () => {
    const updated = await db
      .update(workspaceDeployments)
      .set({
        runGroupId,
        status: "pending" as PreviewStatus,
        // Clear approval state for fresh run
        approvedAt: null,
        approvedBy: null,
      })
      .where(eq(workspaceDeployments.id, deploymentId))
      .returning()

    if (updated.length > 0) {
      const deployment = updated[0]
      events.emitDeploymentUpdate(
        deploymentId,
        deployment.orgId,
        deployment.repo,
        deployment.environmentKind as EnvironmentKind,
        deployment.environmentName,
      )
      return deployment
    }
    return undefined
  })
}

/**
 * Find deployments that are pending and have all upstreams completed (ready to plan).
 * Used by the scheduler to find work.
 */
export async function findReadyToExecuteDeployments(
  runGroupId: string,
  status: PreviewStatus,
): Promise<WorkspaceDeployment[]> {
  return withDbSpan("select", "workspace_deployments", async () => {
    // Get all deployments in the run group with the specified status
    const allDeployments = await db
      .select()
      .from(workspaceDeployments)
      .where(
        and(
          eq(workspaceDeployments.runGroupId, runGroupId),
          eq(workspaceDeployments.status, status),
        ),
      )

    // Filter to only those where completed_upstreams contains all upstream_ids
    return allDeployments.filter(isDeploymentReady)
  })
}


