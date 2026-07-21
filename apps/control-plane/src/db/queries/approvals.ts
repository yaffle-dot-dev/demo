import { and, desc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { approvals, principalRepoBindings, runGroups, workspaceDeployments } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import type { EnvironmentKind } from "../../lib/config-toml.ts"
import {
  ExecutionContextAssociationError,
  isExecutionContextAssociationValid,
  serializeBoundExecutionSnapshotIdentity,
} from "../../lib/execution-snapshot.ts"
import { findPrincipalRepoBindingById } from "./principals.ts"
import { findDeploymentById } from "./workspace-deployments.ts"
import { findRunGroupById } from "./run-groups.ts"
import { enqueueEnvironmentGroupProjectionRebuild } from "../../jobs/environment-group-projections.ts"

export type Approval = typeof approvals.$inferSelect
export type NewApproval = typeof approvals.$inferInsert
export type CreateApproval = Omit<NewApproval, "runGroupId"> & { runGroupId: string }
export type ApprovalWithExecutionContext = Approval & {
  executionContext: ReturnType<typeof serializeBoundExecutionSnapshotIdentity>
}

/**
 * Create an approval record.
 */
export async function createApproval(values: CreateApproval): Promise<Approval> {
  return withDbSpan("insert", "approvals", async () => {
    const [deployment, runGroup] = await Promise.all([
      findDeploymentById(values.deploymentId),
      findRunGroupById(values.runGroupId),
    ])
    const repoBinding = runGroup?.repoBindingId
      ? await findPrincipalRepoBindingById(runGroup.repoBindingId)
      : undefined
    if (
      !deployment ||
      !runGroup ||
      !isExecutionContextAssociationValid({
        snapshot: runGroup.executionSnapshot,
        runGroup,
        resource: deployment,
        canonicalRepoNamespace: repoBinding?.canonicalRepoNamespace,
        requireRepoBinding: deployment.environmentKind === "transient",
      })
    ) {
      throw new ExecutionContextAssociationError(
        "Approval deployment and run group do not share an execution context",
      )
    }

    const rows = await db.insert(approvals).values(values).returning()
    const row = rows[0]
    await enqueueEnvironmentGroupProjectionRebuild({
      orgId: deployment.orgId,
      repo: deployment.repo,
      environmentKind: deployment.environmentKind as EnvironmentKind,
      environmentName: deployment.environmentName,
    })
    return row
  })
}

/**
 * List approvals for a deployment.
 */
export async function listApprovalsForDeployment(
  deploymentId: string,
): Promise<ApprovalWithExecutionContext[]> {
  return withDbSpan("select", "approvals", async () => {
    const rows = await db
      .select({
        approval: approvals,
        runGroup: runGroups,
        deployment: workspaceDeployments,
        canonicalRepoNamespace: principalRepoBindings.canonicalRepoNamespace,
      })
      .from(approvals)
      .innerJoin(workspaceDeployments, eq(approvals.deploymentId, workspaceDeployments.id))
      .innerJoin(
        runGroups,
        and(
          eq(approvals.runGroupId, runGroups.id),
          eq(runGroups.orgId, workspaceDeployments.orgId),
          eq(runGroups.repo, workspaceDeployments.repo),
          eq(runGroups.environmentKind, workspaceDeployments.environmentKind),
          eq(runGroups.environmentName, workspaceDeployments.environmentName),
        ),
      )
      .leftJoin(principalRepoBindings, eq(runGroups.repoBindingId, principalRepoBindings.id))
      .where(eq(approvals.deploymentId, deploymentId))
      .orderBy(desc(approvals.approvedAt))

    return rows.flatMap(({ approval, runGroup, deployment, canonicalRepoNamespace }) => {
      const valid = isExecutionContextAssociationValid({
        snapshot: runGroup.executionSnapshot,
        runGroup,
        resource: deployment,
        canonicalRepoNamespace,
        requireRepoBinding: deployment.environmentKind === "transient",
      })
      const executionContext = valid
        ? serializeBoundExecutionSnapshotIdentity({
            snapshot: runGroup.executionSnapshot,
            runGroup,
            resource: deployment,
          })
        : null
      return executionContext ? [{ ...approval, executionContext }] : []
    })
  })
}

// Alias for backward compatibility
export const listApprovals = listApprovalsForDeployment
