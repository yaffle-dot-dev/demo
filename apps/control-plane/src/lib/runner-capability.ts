import { and, eq } from "drizzle-orm"

import { db } from "./db.ts"
import { iacJobs, tfRuns, workspaceDeployments, workspaces } from "../db/schema.ts"
import type { RunTokenPayload } from "./run-token.ts"

export interface ActiveRunCapability {
  runId: string
  jobId: string
  deploymentId: string
  runGroupId: string
  workspaceId: string
  orgId: string
  runType: "plan" | "apply" | "destroy"
  planPurpose: string
}

export type PersistedRunCapability = Pick<
  ActiveRunCapability,
  "runId" | "jobId" | "workspaceId" | "orgId"
>

function getCapabilityIdentity(
  identity: ActiveRunCapability | PersistedRunCapability | RunTokenPayload,
): PersistedRunCapability & { deploymentId?: string; runGroupId?: string } {
  if ("run_id" in identity) {
    return {
      runId: identity.run_id,
      jobId: identity.job_id,
      deploymentId: identity.deployment_id,
      runGroupId: identity.run_group_id,
      workspaceId: identity.workspace_id,
      orgId: identity.org_id,
    }
  }
  return identity
}

export async function resolveActiveRunCapability(
  identity: ActiveRunCapability | PersistedRunCapability | RunTokenPayload,
): Promise<ActiveRunCapability | null> {
  const requested = getCapabilityIdentity(identity)
  const conditions = [
    eq(tfRuns.id, requested.runId),
    eq(tfRuns.status, "running"),
    eq(iacJobs.status, "running"),
    eq(workspaceDeployments.orgId, requested.orgId),
  ]
  if (requested.deploymentId) {
    conditions.push(eq(tfRuns.deploymentId, requested.deploymentId))
  }
  if (requested.runGroupId) {
    conditions.push(eq(tfRuns.runGroupId, requested.runGroupId))
  }

  const result = (
    await db
      .select({
        runId: tfRuns.id,
        runJobId: tfRuns.jobId,
        runType: tfRuns.runType,
        planPurpose: tfRuns.planPurpose,
        targetWorkspaceId: tfRuns.targetWorkspaceId,
        jobId: iacJobs.id,
        jobType: iacJobs.jobType,
        jobPlanPurpose: iacJobs.planPurpose,
        deploymentId: workspaceDeployments.id,
        runGroupId: iacJobs.runGroupId,
        orgId: workspaceDeployments.orgId,
        repo: workspaceDeployments.repo,
        environmentKind: workspaceDeployments.environmentKind,
        environmentName: workspaceDeployments.environmentName,
        workspacePath: workspaceDeployments.workspacePath,
        ref: workspaceDeployments.ref,
        workspaceId: workspaces.id,
        workspaceOrgId: workspaces.orgId,
        workspaceRepo: workspaces.repo,
        workspaceEnvironmentKind: workspaces.environmentKind,
        workspaceEnvironmentName: workspaces.environmentName,
        workspacePathActual: workspaces.workspacePath,
        workspaceRef: workspaces.ref,
        workspaceStatus: workspaces.status,
      })
      .from(tfRuns)
      .innerJoin(
        iacJobs,
        and(
          eq(iacJobs.id, requested.jobId),
          eq(iacJobs.id, tfRuns.jobId),
          eq(iacJobs.deploymentId, tfRuns.deploymentId),
          eq(iacJobs.runGroupId, tfRuns.runGroupId),
          eq(iacJobs.planPurpose, tfRuns.planPurpose),
        ),
      )
      .innerJoin(
        workspaceDeployments,
        and(
          eq(tfRuns.deploymentId, workspaceDeployments.id),
          eq(workspaceDeployments.runGroupId, tfRuns.runGroupId),
        ),
      )
      .innerJoin(workspaces, eq(workspaces.id, requested.workspaceId))
      .where(and(...conditions))
      .limit(1)
  )[0]

  if (!result || !result.runGroupId || result.runJobId !== result.jobId) {
    return null
  }

  const workspaceMatches =
    result.workspaceOrgId === result.orgId &&
    (result.workspaceStatus === "active" || result.workspaceStatus === "destroying") &&
    (result.planPurpose === "merge_impact"
      ? result.targetWorkspaceId === result.workspaceId
      : result.workspaceRepo === result.repo &&
        result.workspaceEnvironmentKind === result.environmentKind &&
        result.workspaceEnvironmentName === result.environmentName &&
        result.workspacePathActual === result.workspacePath &&
        result.workspaceRef === result.ref)

  if (
    !workspaceMatches ||
    result.runType !== result.jobType ||
    result.planPurpose !== result.jobPlanPurpose
  ) {
    return null
  }

  return {
    runId: result.runId,
    jobId: result.jobId,
    deploymentId: result.deploymentId,
    runGroupId: result.runGroupId,
    workspaceId: result.workspaceId,
    orgId: result.orgId,
    runType: result.runType as "plan" | "apply" | "destroy",
    planPurpose: result.planPurpose,
  }
}
