import { and, desc, eq, gt, inArray, isNull, not, sql, type SQL } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { iacJobs, stateVersions, tfRuns, workspaceDeployments, workspaces } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type StateVersion = typeof stateVersions.$inferSelect
export type NewStateVersion = typeof stateVersions.$inferInsert
export type StateVersionStatus = "pending" | "finalized" | "discarded"

export interface ListStateVersionsOptions {
  status?: StateVersionStatus
  limit?: number
  cursor?: string
}

class StateVersionPublicationConflict extends Error {}

/**
 * Find a state version by its UUID.
 */
export async function findStateVersionById(id: string): Promise<StateVersion | undefined> {
  return withDbSpan("select", "state_versions", async () => {
    const rows = await db.select().from(stateVersions).where(eq(stateVersions.id, id)).limit(1)
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
 * Get the latest state version by serial for serial conflict checks.
 * Excludes discarded versions since they don't count toward the serial sequence.
 * Includes pending versions since they represent in-flight uploads.
 */
export async function getLatestStateVersion(
  workspaceId: string,
): Promise<StateVersion | undefined> {
  return withDbSpan("select", "state_versions", async () => {
    const rows = await db
      .select()
      .from(stateVersions)
      .where(
        and(
          eq(stateVersions.workspaceId, workspaceId),
          // Exclude discarded - they don't count toward serial sequence
          // Include pending (in-flight) and finalized (complete)
          not(eq(stateVersions.status, "discarded")),
        ),
      )
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
export async function createStateVersion(
  values: NewStateVersion,
  runnerCapability?: {
    runId: string
    jobId: string
    deploymentId: string
    runGroupId: string
    workspaceId: string
    orgId: string
  },
): Promise<StateVersion> {
  return withDbSpan("insert", "state_versions", async () => {
    if (!runnerCapability) {
      const rows = await db.insert(stateVersions).values(values).returning()
      return rows[0]
    }
    const lockGeneration = values.lockGeneration
    if (lockGeneration === undefined) {
      throw new StateVersionPublicationConflict()
    }
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
        .innerJoin(
          workspaces,
          and(
            eq(workspaces.id, runnerCapability.workspaceId),
            eq(workspaces.orgId, runnerCapability.orgId),
            eq(workspaces.locked, true),
            eq(workspaces.lockGeneration, lockGeneration),
          ),
        )
        .where(
          and(
            eq(tfRuns.id, runnerCapability.runId),
            eq(tfRuns.jobId, runnerCapability.jobId),
            eq(tfRuns.deploymentId, runnerCapability.deploymentId),
            eq(tfRuns.runGroupId, runnerCapability.runGroupId),
            eq(tfRuns.status, "running"),
            eq(iacJobs.status, "running"),
            eq(workspaceDeployments.orgId, runnerCapability.orgId),
            sql`(
              (
                ${tfRuns.planPurpose} = 'merge_impact'
                AND ${tfRuns.targetWorkspaceId} = ${runnerCapability.workspaceId}
              ) OR (
                ${tfRuns.planPurpose} = 'environment'
                AND ${workspaces.repo} = ${workspaceDeployments.repo}
                AND ${workspaces.environmentKind} = ${workspaceDeployments.environmentKind}
                AND ${workspaces.environmentName} = ${workspaceDeployments.environmentName}
                AND ${workspaces.workspacePath} = ${workspaceDeployments.workspacePath}
                AND ${workspaces.ref} = ${workspaceDeployments.ref}
              )
            )`,
          ),
        )
        .for("share")
        .limit(1)
      if (active.length !== 1) {
        throw new StateVersionPublicationConflict()
      }
      const rows = await tx.insert(stateVersions).values(values).returning()
      return rows[0]
    })
  })
}

/**
 * Finalize a state version (mark as uploaded and ready).
 * Optionally stores outputs extracted from the state file.
 */
export async function finalizeStateVersion(
  stateVersionId: string,
  workspaceId: string,
  expectedLocker: string,
  terraformVersion?: string,
  outputs?: Record<string, unknown>,
  runnerCapability?: { runId: string; jobId: string },
): Promise<StateVersion | undefined> {
  return withDbSpan("update", "state_versions", async () => {
    try {
      return await db.transaction(async (tx) => {
        const rows = await tx
          .update(stateVersions)
          .set({
            status: "finalized",
            uploadTokenHash: sql`CASE
              WHEN ${stateVersions.jsonUploadCompleted} THEN NULL
              ELSE ${stateVersions.uploadTokenHash}
            END`,
            terraformVersion,
            outputs: outputs ?? null,
          })
          .where(
            and(
              eq(stateVersions.id, stateVersionId),
              eq(stateVersions.workspaceId, workspaceId),
              eq(stateVersions.status, "pending"),
              runnerCapability
                ? and(
                    eq(stateVersions.runId, runnerCapability.runId),
                    eq(stateVersions.jobId, runnerCapability.jobId),
                    sql`EXISTS (
                      SELECT 1
                      FROM tf_runs
                      INNER JOIN iac_jobs
                        ON iac_jobs.id = ${runnerCapability.jobId}
                        AND iac_jobs.id = tf_runs.job_id
                        AND iac_jobs.deployment_id = tf_runs.deployment_id
                        AND iac_jobs.run_group_id = tf_runs.run_group_id
                        AND iac_jobs.plan_purpose = tf_runs.plan_purpose
                      INNER JOIN workspace_deployments
                        ON workspace_deployments.id = tf_runs.deployment_id
                        AND workspace_deployments.run_group_id = tf_runs.run_group_id
                      WHERE tf_runs.id = ${runnerCapability.runId}
                        AND tf_runs.status = 'running'
                        AND iac_jobs.status = 'running'
                        AND (
                          (
                            tf_runs.plan_purpose = 'merge_impact'
                            AND tf_runs.target_workspace_id = ${workspaceId}
                          ) OR (
                            tf_runs.plan_purpose = 'environment'
                            AND EXISTS (
                              SELECT 1
                              FROM workspaces
                              WHERE workspaces.id = ${workspaceId}
                                AND workspaces.org_id = workspace_deployments.org_id
                                AND workspaces.repo = workspace_deployments.repo
                                AND workspaces.environment_kind = workspace_deployments.environment_kind
                                AND workspaces.environment_name = workspace_deployments.environment_name
                                AND workspaces.workspace_path = workspace_deployments.workspace_path
                                AND workspaces.ref = workspace_deployments.ref
                            )
                          )
                        )
                    )`,
                  )
                : and(isNull(stateVersions.runId), isNull(stateVersions.jobId)),
            ),
          )
          .returning()
        const finalized = rows[0]
        if (!finalized) {
          throw new StateVersionPublicationConflict()
        }

        const updatedWorkspaces = await tx
          .update(workspaces)
          .set({ currentStateVersionId: finalized.id })
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.locked, true),
              eq(workspaces.lockedBy, expectedLocker),
              eq(workspaces.lockGeneration, finalized.lockGeneration),
              sql`(
                ${workspaces.currentStateVersionId} IS NULL OR EXISTS (
                  SELECT 1
                  FROM state_versions current_state
                  WHERE current_state.id = ${workspaces.currentStateVersionId}
                    AND current_state.serial < ${finalized.serial}
                )
              )`,
            ),
          )
          .returning({ id: workspaces.id })
        if (updatedWorkspaces.length !== 1) {
          throw new StateVersionPublicationConflict()
        }

        return finalized
      })
    } catch (error) {
      if (error instanceof StateVersionPublicationConflict) {
        return undefined
      }
      throw error
    }
  })
}

export async function completeJsonStateUpload(
  stateVersion: StateVersion,
  uploadTokenHash: string,
  runnerCapability?: { runId: string; jobId: string },
): Promise<boolean> {
  return withDbSpan("update", "state_versions", async () => {
    const rows = await db
      .update(stateVersions)
      .set({
        jsonUploadCompleted: true,
        uploadTokenHash: sql`CASE
          WHEN ${stateVersions.status} = 'finalized' THEN NULL
          ELSE ${stateVersions.uploadTokenHash}
        END`,
      })
      .where(
        and(
          eq(stateVersions.id, stateVersion.id),
          eq(stateVersions.uploadTokenHash, uploadTokenHash),
          inArray(stateVersions.status, ["pending", "finalized"]),
          sql`EXISTS (
            SELECT 1
            FROM workspaces
            WHERE workspaces.id = ${stateVersion.workspaceId}
              AND workspaces.locked = true
              AND workspaces.locked_by = ${stateVersion.createdBy}
              AND workspaces.lock_generation = ${stateVersion.lockGeneration}
          )`,
          runnerCapability
            ? sql`EXISTS (
                SELECT 1
                FROM tf_runs
                INNER JOIN iac_jobs
                  ON iac_jobs.id = ${runnerCapability.jobId}
                  AND iac_jobs.id = tf_runs.job_id
                  AND iac_jobs.deployment_id = tf_runs.deployment_id
                  AND iac_jobs.run_group_id = tf_runs.run_group_id
                  AND iac_jobs.plan_purpose = tf_runs.plan_purpose
                INNER JOIN workspace_deployments
                  ON workspace_deployments.id = tf_runs.deployment_id
                  AND workspace_deployments.run_group_id = tf_runs.run_group_id
                WHERE tf_runs.id = ${runnerCapability.runId}
                  AND tf_runs.status = 'running'
                  AND iac_jobs.status = 'running'
                  AND (
                    (
                      tf_runs.plan_purpose = 'merge_impact'
                      AND tf_runs.target_workspace_id = ${stateVersion.workspaceId}
                    ) OR (
                      tf_runs.plan_purpose = 'environment'
                      AND EXISTS (
                        SELECT 1
                        FROM workspaces
                        WHERE workspaces.id = ${stateVersion.workspaceId}
                          AND workspaces.org_id = workspace_deployments.org_id
                          AND workspaces.repo = workspace_deployments.repo
                          AND workspaces.environment_kind = workspace_deployments.environment_kind
                          AND workspaces.environment_name = workspace_deployments.environment_name
                          AND workspaces.workspace_path = workspace_deployments.workspace_path
                          AND workspaces.ref = workspace_deployments.ref
                      )
                    )
                  )
              )`
            : and(isNull(stateVersions.runId), isNull(stateVersions.jobId)),
        ),
      )
      .returning({ id: stateVersions.id })
    return rows.length === 1
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
      .set({ status: "discarded", uploadTokenHash: null })
      .where(and(eq(stateVersions.id, stateVersionId), eq(stateVersions.status, "pending")))
  })
}

/**
 * Discard all pending state versions for a workspace.
 * Used to clean up stale uploads when a new lock is acquired.
 */
export async function discardPendingStateVersions(workspaceId: string): Promise<number> {
  return withDbSpan("update", "state_versions", async () => {
    const result = await db
      .update(stateVersions)
      .set({ status: "discarded", uploadTokenHash: null })
      .where(and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "pending")))
      .returning({ id: stateVersions.id })
    return result.length
  })
}

/**
 * Build an S3 key for a state version.
 * Format: org-{org_id}/{workspace_id}/v{serial}-{state_version_id}.tfstate
 *
 * The org prefix enables per-org IAM isolation in the shared S3 bucket.
 */
export function buildS3Key(
  orgId: string,
  workspaceId: string,
  serial: number,
  stateVersionId: string,
): string {
  return `org-${orgId}/${workspaceId}/v${serial}-${stateVersionId}.tfstate`
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
      .where(and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")))
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
      .where(and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.serial, serial)))
      .limit(1)
    return rows[0]
  })
}
