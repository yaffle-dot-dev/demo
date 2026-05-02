import { desc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { approvals } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import type { EnvironmentKind } from "../../lib/config-toml.ts"
import { findDeploymentById } from "./workspace-deployments.ts"
import { enqueueEnvironmentGroupProjectionRebuild } from "../../jobs/environment-group-projections.ts"

export type Approval = typeof approvals.$inferSelect
export type NewApproval = typeof approvals.$inferInsert

/**
 * Create an approval record.
 */
export async function createApproval(values: NewApproval): Promise<Approval> {
  return withDbSpan("insert", "approvals", async () => {
    const rows = await db.insert(approvals).values(values).returning()
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
 * List approvals for a deployment.
 */
export async function listApprovalsForDeployment(deploymentId: string): Promise<Approval[]> {
  return withDbSpan("select", "approvals", async () => {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.deploymentId, deploymentId))
      .orderBy(desc(approvals.approvedAt))
  })
}

// Alias for backward compatibility
export const listApprovals = listApprovalsForDeployment
