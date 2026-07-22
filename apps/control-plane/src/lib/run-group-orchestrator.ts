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
import { getCurrentStateVersion } from "../db/queries/state-versions.ts"
import { findWorkspaceByIdentity } from "../db/queries/workspaces.ts"
import { checkOrgEntitlements } from "./entitlements.ts"
import { getEnv } from "./env.ts"
import { completeRunGroupCheck } from "./run-group-checks.ts"
import { buildStateKey, transientStatePrefix, environmentStatePrefix } from "./runner.ts"
import { events } from "./events.ts"
import { persistRunGroupWorkspaceMetadataFromArchive } from "./run-group-workspace-metadata.ts"
import { logger } from "./telemetry.ts"
import { syncPrCommentForRunGroup } from "./pr-comment-sync.ts"
import {
  ExecutionSnapshotInvariantError,
  findExecutionSnapshotWorkspace,
} from "./execution-snapshot.ts"
import { bindManagedSharedOutputSnapshots } from "./managed-shared-output-snapshots.ts"

interface RunGroupOrchestratorDependencies {
  completeRunGroupCheck: typeof completeRunGroupCheck
}

const defaultDependencies: RunGroupOrchestratorDependencies = {
  completeRunGroupCheck,
}

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
  dependencies: RunGroupOrchestratorDependencies = defaultDependencies,
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
  const executionSnapshot = runGroup.executionSnapshot
  if (executionSnapshot) {
    const selectedPaths = new Set(executionSnapshot.workspaces.map((workspace) => workspace.path))
    const scanPaths = new Set(executionOrder)
    const selectionChanged =
      selectedPaths.size !== scanPaths.size ||
      [...selectedPaths].some((workspacePath) => !scanPaths.has(workspacePath))
    if (selectionChanged) {
      throw new ExecutionSnapshotInvariantError(
        `Scanner result does not match run group ${runGroupId} workspace selection`,
      )
    }
  }

  await bindManagedSharedOutputSnapshots({
    runGroupId,
    orgId: runGroup.orgId,
    repo: runGroup.repo,
    environmentKind: runGroup.environmentKind,
    selectedWorkspacePaths: executionOrder,
    references: scanResult.moduleOutputReferences ?? [],
  })

  // Store graph + S3 key on run group
  await updateRunGroupDependencyGraph(runGroupId, graph)
  if (workspaceS3Key) {
    await updateRunGroupWorkspaceS3Key(runGroupId, workspaceS3Key)
  }
  await persistRunGroupWorkspaceMetadataFromArchive({
    runGroup,
    workspacePaths: executionOrder,
    workspaceS3Key: workspaceS3Key ?? null,
    source: "scan_job",
  })

  logger.info("Completing run group from scan result", {
    runGroupId,
    workspaceCount: executionOrder.length,
    edgeCount: graph.edges.length,
  })

  // Check entitlements
  const entitlement = await checkOrgEntitlements(
    org,
    runGroup.environmentKind,
    runGroup.environmentName,
  )

  // Build state prefix based on environment kind
  const environmentKind = executionSnapshot?.environment.kind ?? runGroup.environmentKind
  const environmentName = executionSnapshot?.environment.name ?? runGroup.environmentName
  const statePrefix =
    environmentKind === "transient"
      ? transientStatePrefix(environmentName)
      : environmentStatePrefix(environmentName)

  // Build dependency maps
  const workspaceDeps = new Map<string, Set<string>>()
  for (const [downstream, upstream] of graph.edges) {
    if (!workspaceDeps.has(downstream)) {
      workspaceDeps.set(downstream, new Set())
    }
    workspaceDeps.get(downstream)!.add(upstream)
  }

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
    const workspaceSnapshot = findExecutionSnapshotWorkspace(executionSnapshot, wsPath)
    const source = executionSnapshot?.source

    const deployment = await upsertDeployment({
      orgId: org.id,
      installationId: source?.installationId,
      repo: source?.repository ?? runGroup.repo,
      environmentKind,
      environmentName,
      prNumber:
        executionSnapshot?.environment.sourcePullRequestNumber ?? runGroup.prNumber ?? undefined,
      workspacePath: wsPath,
      ref: source?.ref ?? runGroup.ref,
      headSha: source?.commitSha ?? runGroup.headSha,
      authorGithubId: source?.actor.githubId ?? undefined,
      authorLogin: source?.actor.login ?? undefined,
      stateKey,
      mode: "terraform",
      requireApproval: workspaceSnapshot?.approval.required ?? false,
      approvers: workspaceSnapshot?.approval.approvers ?? null,
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
    await dependencies.completeRunGroupCheck({
      runGroupId,
      conclusion: "failure",
      title: "Failed due to plan limits",
      summary: withBillingUrl(org.slug, entitlement.message),
    })
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
          runGroupId,
          jobType: "plan",
        })
        logger.info("Queued plan job for root workspace", {
          runGroupId,
          workspacePath,
          deploymentId,
          jobId: job.id,
        })
      }

      const mergeImpact = executionSnapshot?.mergeImpact
      if (mergeImpact?.workspaces.some((workspace) => workspace.path === workspacePath)) {
        const targetWorkspace = await findWorkspaceByIdentity(
          org.id,
          executionSnapshot?.source.repository ?? runGroup.repo,
          workspacePath,
          "named",
          mergeImpact.environmentName,
        )
        const targetState =
          targetWorkspace?.status === "active"
            ? await getCurrentStateVersion(targetWorkspace.id)
            : undefined
        if (targetWorkspace && targetState?.status === "finalized") {
          const mergeJob = await createIacJob({
            deploymentId,
            runGroupId,
            jobType: "plan",
            planPurpose: "merge_impact",
            targetWorkspaceId: targetWorkspace.id,
            targetStateVersionId: targetState.id,
          })
          logger.info("Queued merge-impact plan", {
            runGroupId,
            workspacePath,
            targetEnvironment: mergeImpact.environmentName,
            targetStateVersionId: targetState.id,
            jobId: mergeJob.id,
          })
        }
      }
    }
  }

  // Mark removed workspaces as destroyed only for push-triggered named-environment runs.
  // Manual subset selection can intentionally scan/deploy a subset of workspaces and
  // must not destroy unrelated named-environment deployments.
  if (environmentKind === "named" && runGroup.trigger === "push") {
    await markRemovedWorkspacesDestroyed(
      org.id,
      runGroup.repo,
      environmentName,
      executionSnapshot?.source.commitSha ?? runGroup.headSha,
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
      environmentKind,
      environmentName,
    )
  }

  logger.info("Run group completed", {
    runGroupId,
    deploymentCount: deploymentData.length,
    rootCount: deploymentData.filter((d) => d.isRoot).length,
  })
  void syncPrCommentForRunGroup(runGroupId)
}

function buildBillingUrl(orgSlug: string): string | undefined {
  const appUrl = getEnv().betterAuthUrl.trim().replace(/\/$/, "")
  if (!appUrl) {
    return undefined
  }

  return `${appUrl}/${orgSlug}/settings/billing`
}

function withBillingUrl(orgSlug: string, message: string): string {
  const billingUrl = buildBillingUrl(orgSlug)
  if (!billingUrl) {
    return message
  }

  return message.replace(`/${orgSlug}/settings/billing`, billingUrl)
}
