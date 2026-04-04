/**
 * Run Group Orchestrator
 *
 * Handles the post-scan completion flow: creating deployments,
 * setting upstream relationships, and queuing plan jobs.
 *
 * Called from:
 * - Scanner complete endpoint (push/PR events)
 * - Webhook handler directly (branch deletion / destroy)
 */

import type { ScanJobResult } from "../db/queries/scan-jobs.ts"
import {
  findRunGroupById,
  updateRunGroupDependencyGraph,
  updateRunGroupWorkspaceS3Key,
  updateRunGroupStatus,
} from "../db/queries/run-groups.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import {
  setDeploymentUpstreams,
  updateDeploymentStatus,
  upsertDeployment,
  markRemovedWorkspacesDestroyed,
} from "../db/queries/workspace-deployments.ts"
import { createIacJob, cancelJobsForPreview } from "../db/queries/iac-jobs.ts"
import { checkOrgEntitlements } from "./entitlements.ts"
import { buildStateKey, previewStatePrefix, environmentStatePrefix } from "./runner.ts"
import { events } from "./events.ts"
import { logger } from "./telemetry.ts"

/**
 * Complete a run group after the scanner reports results.
 *
 * This is the continuation of the webhook handler flow:
 * 1. Store graph + S3 key on run group
 * 2. Create deployments with upstream/downstream relationships
 * 3. Queue plan jobs for root workspaces
 * 4. Update run group status
 */
export async function completeRunGroup(
  runGroupId: string,
  scanResult: ScanJobResult,
): Promise<void> {
  const runGroup = await findRunGroupById(runGroupId)
  if (!runGroup) {
    throw new Error(`Run group ${runGroupId} not found`)
  }

  const org = await findOrgById(runGroup.orgId)
  if (!org) {
    throw new Error(`Org ${runGroup.orgId} not found`)
  }

  const { graph, executionOrder, workspaceS3Key } = scanResult

  // Store graph + S3 key on run group
  await updateRunGroupDependencyGraph(runGroupId, graph)
  if (workspaceS3Key) {
    await updateRunGroupWorkspaceS3Key(runGroupId, workspaceS3Key)
  }

  logger.info("Completing run group from scan result", {
    runGroupId,
    workspaceCount: executionOrder.length,
    edgeCount: graph.edges.length,
  })

  // Check entitlements
  const entitlement = await checkOrgEntitlements(
    org,
    runGroup.environmentKind === "transient" ? "pull_request" : "push",
    runGroup.environmentName,
  )

  // Build state prefix based on environment kind
  const statePrefix = runGroup.environmentKind === "transient"
    ? previewStatePrefix(runGroup.prNumber!)
    : environmentStatePrefix(runGroup.environmentName)

  // Build dependency maps
  const workspaceDeps = new Map<string, Set<string>>()
  for (const [downstream, upstream] of graph.edges) {
    if (!workspaceDeps.has(downstream)) {
      workspaceDeps.set(downstream, new Set())
    }
    workspaceDeps.get(downstream)!.add(upstream)
  }

  // Environment info comes from the run group row (set by webhook handler)
  const environmentName = runGroup.environmentName

  // First pass: upsert all deployments with run_group_id
  const pathToDeploymentId = new Map<string, string>()
  const deploymentData: Array<{
    workspacePath: string
    deploymentId: string
    isRoot: boolean
  }> = []

  for (const wsPath of executionOrder) {
    const stateKey = buildStateKey(statePrefix, wsPath)
    const upstreamPaths = workspaceDeps.get(wsPath) ?? new Set()
    const isRoot = upstreamPaths.size === 0

    const deployment = await upsertDeployment({
      orgId: org.id,
      installationId: undefined, // Will be set from run group context if needed
      repo: runGroup.repo,
      environmentKind: runGroup.environmentKind as "named" | "transient",
      environmentName,
      prNumber: runGroup.prNumber ?? undefined,
      workspacePath: wsPath,
      ref: runGroup.ref,
      headSha: runGroup.headSha,
      stateKey,
      mode: "terraform",
      requireApproval: false, // TODO: resolve from config approvers
      approvers: null,
      runGroupId,
    })

    pathToDeploymentId.set(wsPath, deployment.id)
    deploymentData.push({ workspacePath: wsPath, deploymentId: deployment.id, isRoot })
  }

  // Second pass: set upstream_ids
  for (const { workspacePath, deploymentId } of deploymentData) {
    const upstreamPaths = workspaceDeps.get(workspacePath) ?? new Set()
    if (upstreamPaths.size > 0) {
      const upstreamIds = [...upstreamPaths]
        .map((path) => pathToDeploymentId.get(path))
        .filter((id): id is string => id !== undefined)

      await setDeploymentUpstreams(deploymentId, upstreamIds)
    }
  }

  // Third pass: cancel any pending jobs (for PR reopen) and queue plan jobs
  for (const { deploymentId } of deploymentData) {
    await cancelJobsForPreview(deploymentId)
  }

  if (!entitlement.allowed) {
    // Plan-limited
    for (const { deploymentId } of deploymentData) {
      await updateDeploymentStatus(deploymentId, "plan_limited")
    }
    logger.warn("Run group plan-limited", {
      runGroupId,
      code: entitlement.code,
    })
  } else {
    // Queue plan jobs for root workspaces
    for (const { workspacePath, deploymentId, isRoot } of deploymentData) {
      if (isRoot) {
        const job = await createIacJob({
          deploymentId,
          jobType: "plan",
        })
        logger.info("Queued plan job for root workspace", {
          runGroupId,
          workspacePath,
          deploymentId,
          jobId: job.id,
        })
      }
    }
  }

  // Mark removed workspaces as destroyed (push events only)
  if (runGroup.environmentKind === "named") {
    await markRemovedWorkspacesDestroyed(
      org.id,
      runGroup.repo,
      environmentName,
      runGroup.headSha,
      executionOrder,
    )
  }

  // Update run group status
  await updateRunGroupStatus(runGroupId, "running", { startedAt: new Date() })

  // Emit event for UI
  if (deploymentData.length > 0) {
    events.emitDeploymentUpdate(
      deploymentData[0].deploymentId,
      org.id,
      runGroup.repo,
      runGroup.environmentKind as "named" | "transient",
      environmentName,
    )
  }

  logger.info("Run group completed", {
    runGroupId,
    deploymentCount: deploymentData.length,
    rootCount: deploymentData.filter((d) => d.isRoot).length,
  })
}
