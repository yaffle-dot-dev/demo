import { SpanKind } from "@opentelemetry/api"

import type {
  PullRequestContext,
  PushContext,
  WebhookContext,
} from "@yaffle/shared"

import {
  type YaffleTomlConfig,
  buildPrEnvironmentName,
  ConfigError,
  findPushTriggerEnvironment,
  getWorkspacesForEnvironment,
  matchesPullRequestTrigger,
  parseYaffleToml,
  resolveApprovers,
} from "./config-toml.ts"
import { ensureOrg } from "../db/queries/organizations.ts"
import {
  markRemovedWorkspacesDestroyed,
  findDeploymentById,
  findDeploymentsByEnvironment,
  setDeploymentUpstreams,
  updateDeploymentStatus,
  upsertDeployment,
  recordDeploymentApproval,
  resetSkippedDownstreams,
} from "../db/queries/workspace-deployments.ts"
import { createIacJob, cancelJobsForPreview, findPendingJobsForPreview } from "../db/queries/iac-jobs.ts"
import { findLatestRun } from "../db/queries/tf-runs.ts"
import { createRunGroup, updateRunGroupDependencyGraph, updateRunGroupWorkspaceS3Key, type RunGroupTrigger } from "../db/queries/run-groups.ts"
import { events } from "./events.ts"
import {
  createCheckRun,
  fetchFileContent,
  getInstallationToken,
} from "./github.ts"
import {
  type CheckRunRef,
  checkRunUrl,
  createCommentManager,
} from "./pr-comment.ts"
import { LocalRunner } from "./local-runner.ts"
import { KeyedMutex } from "./mutex.ts"
import {
  type Runner,
  buildStateKey,
  previewStatePrefix,
  environmentStatePrefix,
} from "./runner.ts"

import {
  beginWorkspaceArchive,
  getWorkspacesToArchive,
} from "./workspace-service.ts"
import { useTfcBackend } from "./tfc-backend.ts"
import {
  getConfigLoadErrorCounter,
  logger,
  withSpan,
} from "./telemetry.ts"
import { scanAllWorkspaceDependencies } from "./module-dependency-scanner.ts"
import { buildGraphFromInferred, type SerializableDependencyGraph } from "./dependency-graph.ts"
import { prepareWorkspace, cleanupWorkspace } from "./workspace.ts"
import { createWorkspaceCache } from "./workspace-cache.ts"

const CHECK_NAME = "Yaffle / terraform"

/** Default runner for production use. Override via createHandler() for tests. */
const defaultRunner: Runner = new LocalRunner()

/**
 * Per-preview mutex. Ensures that concurrent webhook events for the same
 * preview (owner/repo/pr) are processed sequentially. Different previews
 * still run concurrently.
 */
const previewMutex = new KeyedMutex()

/** Build the mutex key for a webhook context. */
function mutexKey(ctx: WebhookContext): string {
  if (ctx.kind === "pull_request") {
    return `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  }
  return `${ctx.owner}/${ctx.repo}@${ctx.ref}`
}

/** Common span attributes from a webhook context. */
function contextAttrs(ctx: WebhookContext): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    "yaffle.owner": ctx.owner,
    "yaffle.repo": ctx.repo,
    "yaffle.head_sha": ctx.headSha,
    "yaffle.event_kind": ctx.kind,
  }
  if (ctx.kind === "pull_request") {
    attrs["yaffle.pr_number"] = ctx.prNumber
    attrs["yaffle.pr_action"] = ctx.action
    attrs["yaffle.branch"] = ctx.branch
  } else {
    attrs["yaffle.ref"] = ctx.ref
    attrs["yaffle.ref_type"] = ctx.refType
    attrs["yaffle.ref_name"] = ctx.refName
  }
  return attrs
}

/**
 * Optional config loader override for testing.
 * In production, we fetch config via the GitHub API.
 * In tests, we inject a fake loader.
 */
type ConfigLoader = (ctx: WebhookContext, token?: string) => Promise<YaffleTomlConfig>

/**
 * Result of scanning workspace dependencies and computing execution order.
 */
interface DependencyScanResult {
  /** Serializable graph for storage/UI */
  graph: SerializableDependencyGraph
  /** Workspace paths in topological execution order */
  executionOrder: string[]
  /** S3 key for cached workspace (if uploaded) */
  workspaceS3Key?: string
}

/**
 * Scan repository for workspace dependencies and compute execution order.
 *
 * Clones the repo, scans all workspace directories for Yaffle module references,
 * builds a dependency graph, and returns the topological execution order.
 *
 * Also uploads the workspace to S3 cache for later use by runners.
 *
 * @param ctx - Webhook context with repo info
 * @param orgSlug - Organization slug for S3 key
 * @param orgId - Organization ID for resource tagging
 * @param workspacePaths - List of workspace paths from config
 * @param installationToken - GitHub token for cloning
 * @returns Dependency graph, execution order, and workspace S3 key
 */
async function scanDependencies(
  ctx: WebhookContext,
  orgSlug: string,
  orgId: string,
  workspacePaths: string[],
  installationToken?: string,
): Promise<DependencyScanResult> {
  return withSpan("scan_dependencies", async (span) => {
    span.setAttributes({
      "yaffle.workspace_count": workspacePaths.length,
    })

    // Clone repo to scan for dependencies
    let repoDir: string | undefined
    let workspaceS3Key: string | undefined
    try {
      repoDir = await prepareWorkspace({
        owner: ctx.owner,
        repo: ctx.repo,
        headSha: ctx.headSha,
        installationToken,
      })

      // Scan all workspaces for module dependencies
      const inferredGraph = await scanAllWorkspaceDependencies(repoDir, workspacePaths)

      // Build the graph and check for cycles
      const graph = buildGraphFromInferred(inferredGraph.workspaces, inferredGraph.edges)
      const cycleCheck = graph.detectCycle()

      if (cycleCheck.hasCycle) {
        const cyclePath = cycleCheck.cyclePath?.join(" → ") ?? "unknown"
        throw new ConfigError(`Circular dependency detected: ${cyclePath}`)
      }

      // Get topological order
      const executionOrder = graph.getTopologicalOrder()
      if (!executionOrder) {
        throw new ConfigError("Failed to compute execution order (possible cycle)")
      }

      // Filter to only include workspaces that are in the config
      // (the graph might include external dependencies)
      const configPaths = new Set(workspacePaths)
      const filteredOrder = executionOrder.filter((path) => configPaths.has(path))

      // Add any workspaces from config that weren't in the graph (no dependencies)
      for (const path of workspacePaths) {
        if (!filteredOrder.includes(path)) {
          filteredOrder.push(path)
        }
      }

      // Upload workspace to S3 cache for runners
      try {
        const cache = createWorkspaceCache()
        workspaceS3Key = await cache.upload(orgSlug, orgId, ctx.repo, ctx.headSha, repoDir)
        logger.info("Workspace uploaded to S3 cache", {
          "workspace.s3_key": workspaceS3Key,
          "workspace.org": orgSlug,
          "workspace.repo": ctx.repo,
          "workspace.sha": ctx.headSha.slice(0, 7),
        })
        span.setAttributes({
          "yaffle.workspace_s3_key": workspaceS3Key,
        })
      } catch (err) {
        // Log but don't fail - runners can fall back to git clone
        logger.warn("Failed to upload workspace to S3 cache", {
          error: err instanceof Error ? err.message : String(err),
          "workspace.org": orgSlug,
          "workspace.repo": ctx.repo,
          "workspace.sha": ctx.headSha.slice(0, 7),
        })
      }

      logger.info("Dependency scan complete", {
        "yaffle.execution_order": filteredOrder,
        "yaffle.edge_count": inferredGraph.edges.length,
      })

      span.setAttributes({
        "yaffle.execution_order": filteredOrder.join(", "),
        "yaffle.edge_count": inferredGraph.edges.length,
      })

      return {
        graph: graph.toSerializable(),
        executionOrder: filteredOrder,
        workspaceS3Key,
      }
    } finally {
      if (repoDir) {
        await cleanupWorkspace(repoDir)
      }
    }
  })
}

/**
 * Create a handler with an injected runner and optional overrides.
 * Used by tests to avoid real git clone + tofu invocations.
 */
export function createHandler(
  runner: Runner,
  opts?: { mutex?: KeyedMutex; configLoader?: ConfigLoader },
): {
  handleWebhookEvent: (ctx: WebhookContext) => Promise<void>
} {
  const m = opts?.mutex ?? new KeyedMutex()
  const loader = opts?.configLoader ?? fetchConfig
  return {
    handleWebhookEvent: (ctx: WebhookContext) =>
      m.run(mutexKey(ctx), () => handleEvent(ctx, runner, loader)),
  }
}

/**
 * Handle a webhook event using the default runner.
 * Serialized per-preview via the global mutex.
 */
export async function handleWebhookEvent(ctx: WebhookContext): Promise<void> {
  return previewMutex.run(mutexKey(ctx), () =>
    handleEvent(ctx, defaultRunner, fetchConfig),
  )
}

/**
 * Trigger apply for a preview that has a successful plan.
 * Used by the UI when:
 * - Auto-apply countdown completes (PR or non-requireApproval env)
 * - User clicks "Approve" button (requireApproval env)
 *
 * This function validates state, records approval, and queues an apply job.
 * The IaC engine handles actual execution.
 */
export async function triggerApply(opts: {
  previewId: string
  /** User ID from auth context */
  userId?: string | null
  /** Display name for audit trail */
  approverLogin?: string | null
}): Promise<{ applyStarted: boolean; jobId: string }> {
  return previewMutex.run(`apply:${opts.previewId}`, async () => {
    const preview = await findDeploymentById(opts.previewId)
    if (!preview) {
      throw new Error("preview not found")
    }

    // Check that preview is in awaiting_apply state
    if (preview.status !== "awaiting_apply") {
      throw new Error(`preview is in ${preview.status} state, expected awaiting_apply`)
    }

    // Check that plan succeeded
    const latestPlan = await findLatestRun(preview.id, "plan")
    if (!latestPlan || latestPlan.status !== "success") {
      throw new Error("no successful plan to apply")
    }

    // Check that apply isn't already queued/running/completed for this plan
    const { findPendingJobsForPreview, findLatestIacJob } = await import("../db/queries/iac-jobs.ts")
    const pendingApplyJobs = await findPendingJobsForPreview(preview.id, "apply")
    if (pendingApplyJobs.length > 0) {
      throw new Error("apply already queued or in progress")
    }

    const latestApplyJob = await findLatestIacJob(preview.id, "apply")
    if (latestApplyJob && latestApplyJob.status === "completed") {
      // Check if this completed job is for the current plan
      // (by comparing timestamps - apply should be after plan)
      if (latestApplyJob.completedAt && latestPlan.completedAt &&
          latestApplyJob.completedAt > latestPlan.completedAt) {
        throw new Error("apply already completed for this plan")
      }
    }

    // Record approval if approver info provided
    if (opts.userId) {
      await recordDeploymentApproval(preview.id, opts.userId)

      // Also record in approvals table for audit trail
      if (preview.requireApproval) {
        const { createApproval } = await import("../db/queries/approvals.ts")
        await createApproval({
          deploymentId: preview.id,
          userId: opts.userId,
          approverLogin: opts.approverLogin ?? null,
        })
      }

      logger.info("Approval recorded", {
        deploymentId: preview.id,
        userId: opts.userId,
        approverLogin: opts.approverLogin ?? "unknown",
      })
    }

    // Queue apply job
    const job = await createIacJob({
      deploymentId: preview.id,
      jobType: "apply",
    })

    logger.info("Apply job queued", {
      deploymentId: preview.id,
      jobId: job.id,
      workspacePath: preview.workspacePath,
    })

    // Emit event so UI sees the job queued
    events.emitDeploymentUpdate(
      preview.id,
      preview.orgId,
      preview.repo,
      preview.environmentKind as "named" | "transient",
      preview.environmentName,
    )

    return { applyStarted: true, jobId: job.id }
  })
}

/**
 * Queue an apply job for server-side auto-apply.
 * Used by the scheduler when a deployment has been in 'awaiting_apply' state
 * long enough without being paused.
 *
 * Unlike triggerApply(), this function:
 * - Does not record approval (no user involved)
 * - Returns gracefully if the deployment is no longer in awaiting_apply state
 *   (e.g., user paused it or another scheduler instance already claimed it)
 *
 * @returns job ID if apply was queued, null if deployment was not claimable
 */
export async function queueAutoApply(deploymentId: string): Promise<{ jobId: string } | null> {
  return previewMutex.run(`apply:${deploymentId}`, async () => {
    const preview = await findDeploymentById(deploymentId)
    if (!preview) {
      logger.warn("Auto-apply: deployment not found", { deploymentId })
      return null
    }

    // Check state - if not awaiting_apply, someone else handled it (paused or applied)
    if (preview.status !== "awaiting_apply") {
      logger.debug("Auto-apply: deployment not in awaiting_apply state", {
        deploymentId,
        status: preview.status,
      })
      return null
    }

    // Double-check requireApproval (shouldn't be true if scheduler found it, but defensive)
    if (preview.requireApproval) {
      logger.warn("Auto-apply: deployment requires approval, skipping", { deploymentId })
      return null
    }

    // Check that plan succeeded
    const latestPlan = await findLatestRun(preview.id, "plan")
    if (!latestPlan || latestPlan.status !== "success") {
      logger.warn("Auto-apply: no successful plan", { deploymentId })
      return null
    }

    // Check that apply isn't already queued/running
    const { findPendingJobsForPreview } = await import("../db/queries/iac-jobs.ts")
    const pendingApplyJobs = await findPendingJobsForPreview(preview.id, "apply")
    if (pendingApplyJobs.length > 0) {
      logger.debug("Auto-apply: apply already queued", { deploymentId })
      return null
    }

    // Queue apply job (no approval recording - this is server-initiated)
    const job = await createIacJob({
      deploymentId: preview.id,
      jobType: "apply",
    })

    logger.info("Auto-apply job queued", {
      deploymentId: preview.id,
      jobId: job.id,
      workspacePath: preview.workspacePath,
      environmentName: preview.environmentName,
    })

    // Emit event so UI sees the job queued
    events.emitDeploymentUpdate(
      preview.id,
      preview.orgId,
      preview.repo,
      preview.environmentKind as "named" | "transient",
      preview.environmentName,
    )

    return { jobId: job.id }
  })
}

/**
 * Manually re-run a preview (plan only - apply requires explicit approval).
 * This allows users to re-trigger a run without pushing new commits.
 *
 * The preview stays in its existing run group. We just reset status to pending
 * and queue a new plan job. The scheduler picks it up like any other job.
 *
 * If this workspace had downstream workspaces that were skipped due to its
 * failure, those downstreams are reset to pending so they will be scheduled
 * when this workspace's apply succeeds.
 */
export async function rerunPreview(opts: {
  previewId: string
  triggeredBy?: string | null
}): Promise<{ runGroupId: string; jobId: string }> {
  return previewMutex.run(`rerun:${opts.previewId}`, async () => {
    const preview = await findDeploymentById(opts.previewId)
    if (!preview) {
      throw new Error("preview not found")
    }

    // Check for pending jobs (not tf_runs - check the job queue)
    const pendingJobs = await findPendingJobsForPreview(preview.id)
    if (pendingJobs.length > 0) {
      throw new Error("a job is already queued or running for this preview")
    }

    if (!preview.runGroupId) {
      throw new Error("preview has no run group")
    }

    // Reset preview status to pending (keeps existing run group)
    await updateDeploymentStatus(preview.id, "pending")

    // Reset any downstream workspaces that were skipped due to this upstream's failure.
    // This allows them to be scheduled when this workspace's apply succeeds.
    const resetCount = await resetSkippedDownstreams(preview.id)
    if (resetCount > 0) {
      logger.info("Reset skipped downstream workspaces for re-run", {
        deploymentId: opts.previewId,
        workspacePath: preview.workspacePath,
        resetCount,
      })
    }

    // Queue a plan job - the scheduler will pick it up
    const job = await createIacJob({
      deploymentId: preview.id,
      jobType: "plan",
    })

    logger.info("Manual re-run queued", {
      deploymentId: opts.previewId,
      runGroupId: preview.runGroupId,
      jobId: job.id,
      triggeredBy: opts.triggeredBy ?? "unknown",
      workspacePath: preview.workspacePath,
    })

    return { runGroupId: preview.runGroupId, jobId: job.id }
  })
}

/**
 * Fetch config from the repo via the GitHub Contents API.
 */
async function fetchConfig(ctx: WebhookContext, _token?: string): Promise<YaffleTomlConfig> {
  if (!ctx.installationId) {
    throw new ConfigError(
      "Cannot fetch config without a GitHub App installation",
    )
  }

  const raw = await fetchFileContent(
    ctx.installationId,
    ctx.owner,
    ctx.repo,
    "yaffle.toml",
    ctx.headSha,
  )

  if (!raw) {
    throw new ConfigError(
      "No yaffle.toml found. Yaffle requires a config file. See https://yaffle.dev/docs/config",
    )
  }

  return parseYaffleToml(raw)
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

async function handleEvent(
  ctx: WebhookContext,
  runner: Runner,
  configLoader: ConfigLoader,
): Promise<void> {
  const spanName = ctx.kind === "pull_request"
    ? `webhook.pull_request.${ctx.action}`
    : "webhook.push"

  return withSpan(spanName, async (span) => {
    span.setAttributes(contextAttrs(ctx))

    if (ctx.kind === "pull_request") {
      await handlePullRequestEvent(ctx, runner, configLoader)
    } else {
      await handlePushEvent(ctx, runner, configLoader)
    }
  }, { kind: SpanKind.INTERNAL })
}

// ---------------------------------------------------------------------------
// Pull request events
// ---------------------------------------------------------------------------

async function handlePullRequestEvent(
  ctx: PullRequestContext,
  runner: Runner,
  configLoader: ConfigLoader,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  const attrs = contextAttrs(ctx)
  logger.info(`handling PR event: ${tag} action=${ctx.action} sha=${ctx.headSha}`, attrs)

  switch (ctx.action) {
    case "opened":
    case "reopened":
    case "synchronize":
      await handlePrOpenedOrUpdated(ctx, runner, configLoader)
      break

    case "closed":
      await handlePrClosed(ctx, runner, configLoader)
      break
  }
}

/**
 * PR opened/updated -- load config, set up DAG, queue plan jobs for root workspaces.
 *
 * This function no longer executes plans inline. Instead:
 * 1. Creates previews for all workspaces with upstream dependency info
 * 2. Queues plan jobs for root workspaces (no dependencies)
 * 3. The IaC engine handles execution and queues downstream jobs when ready
 */
async function handlePrOpenedOrUpdated(
  ctx: PullRequestContext,
  _runner: Runner, // Kept for API compatibility; execution now happens via IaC engine
  configLoader: ConfigLoader,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  const attrs = contextAttrs(ctx)
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId, ctx.installationId)
  const installationToken = await acquireToken(ctx)

  // Load config
  let config: YaffleTomlConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    await surfaceConfigError(ctx, msg)
    return
  }

  // Check if this branch matches any pull_request trigger
  if (!matchesPullRequestTrigger(config, ctx.branch)) {
    logger.info(`ignoring PR for branch that doesn't match any trigger`, {
      ...attrs,
      branch: ctx.branch,
    })
    return
  }

  // Get workspaces that apply to transient (PR) environments
  const environmentName = buildPrEnvironmentName(ctx.prNumber)
  const workspacePaths = getWorkspacesForEnvironment(config, environmentName, true)

  if (workspacePaths.length === 0) {
    logger.info("no workspaces configured for transient environments", attrs)
    return
  }

  const wsPaths = workspacePaths.join(", ")
  logger.info(
    `config loaded: ${workspacePaths.length} workspace(s) for PR [${wsPaths}]`,
    { ...attrs, "yaffle.workspace_count": workspacePaths.length },
  )

  const statePrefix = previewStatePrefix(ctx.prNumber)
  const comment = createCommentManager(ctx)

  // Create a single run group for this PR event (covers both plan and apply)
  const trigger: RunGroupTrigger = ctx.action === "opened" ? "pr_opened" : "pr_sync"
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: ctx.repo,
    environmentKind: "transient",
    environmentName,
    prNumber: ctx.prNumber,
    ref: `refs/heads/${ctx.branch}`,
    headSha: ctx.headSha,
    trigger,
    status: "pending",
  })

  // Filter config.workspaces to only those that apply to this environment
  const activeWorkspaces = config.workspaces.filter((ws) => workspacePaths.includes(ws.path))
  let executionOrder: string[]
  let dependencyGraph: SerializableDependencyGraph

  try {
    const scanResult = await scanDependencies(ctx, org.slug, org.id, workspacePaths, installationToken)
    executionOrder = scanResult.executionOrder
    dependencyGraph = scanResult.graph

    // Store the dependency graph in the run group for UI
    await updateRunGroupDependencyGraph(runGroup.id, dependencyGraph)

    // Store the workspace S3 key in the run group for runners
    if (scanResult.workspaceS3Key) {
      await updateRunGroupWorkspaceS3Key(runGroup.id, scanResult.workspaceS3Key)
    }

    logger.info("Execution order determined", {
      ...attrs,
      "yaffle.execution_order": executionOrder,
    })
  } catch (err) {
    // If dependency scan fails, fall back to config order
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`Dependency scan failed, using config order: ${msg}`, attrs)
    executionOrder = workspacePaths
    dependencyGraph = { workspaces: workspacePaths, edges: [] }
  }

  // Create a map for quick workspace lookup by path
  const workspaceByPath = new Map(activeWorkspaces.map((ws) => [ws.path, ws]))

  // Build dependency maps:
  // - workspaceDeps: workspace path -> set of upstream workspace paths
  // - pathToPreviewId: workspace path -> preview ID (populated after upsert)
  const workspaceDeps = new Map<string, Set<string>>()
  for (const [downstream, upstream] of dependencyGraph.edges) {
    if (!workspaceDeps.has(downstream)) {
      workspaceDeps.set(downstream, new Set())
    }
    workspaceDeps.get(downstream)!.add(upstream)
  }

  // First pass: upsert all previews with run_group_id
  // This ensures all workspaces appear in the UI immediately
  const pathToPreviewId = new Map<string, string>()
  const previewData: Array<{
    ws: typeof config.workspaces[0]
    preview: { id: string }
    stateKey: string
    isRoot: boolean // true if no upstream dependencies
  }> = []

  for (const wsPath of executionOrder) {
    const ws = workspaceByPath.get(wsPath)
    if (!ws) continue

    const stateKey = buildStateKey(statePrefix, ws.path)
    const upstreamPaths = workspaceDeps.get(ws.path) ?? new Set()
    const isRoot = upstreamPaths.size === 0

    // Resolve approvers from approval rules (supports transient environments via "*")
    const approvers = resolveApprovers(config, ws.path, environmentName)
    const requireApproval = approvers.length > 0

    // Upsert preview with run_group_id
    // PRs are always branch-based, so construct the full ref
    const preview = await upsertDeployment({
      orgId: org.id,
      installationId: ctx.installationId,
      repo: ctx.repo,
      environmentKind: "transient",
      environmentName,
      prNumber: ctx.prNumber,
      workspacePath: ws.path,
      ref: `refs/heads/${ctx.branch}`,
      headSha: ctx.headSha,
      authorGithubId: ctx.authorGithubId,
      authorLogin: ctx.authorLogin,
      stateKey,
      mode: "terraform",
      requireApproval,
      approvers: approvers.length > 0 ? approvers : null,
      runGroupId: runGroup.id,
    })

    pathToPreviewId.set(ws.path, preview.id)
    previewData.push({ ws, preview, stateKey, isRoot })
  }

  // Second pass: set upstream_ids on each preview (now that we have all preview IDs)
  for (const { ws, preview } of previewData) {
    const upstreamPaths = workspaceDeps.get(ws.path) ?? new Set()
    if (upstreamPaths.size > 0) {
      const upstreamIds = [...upstreamPaths]
        .map((path) => pathToPreviewId.get(path))
        .filter((id): id is string => id !== undefined)

      await setDeploymentUpstreams(preview.id, upstreamIds)

      logger.info("Set upstream dependencies for deployment", {
        deploymentId: preview.id,
        workspacePath: ws.path,
        upstreamIds,
      })
    }
  }

  // Third pass: cancel any pending destroy jobs and queue plan jobs
  // On PR reopen, there may be pending destroy jobs from a previous close
  // that need to be cancelled before queueing new plan jobs
  for (const { preview } of previewData) {
    const cancelledCount = await cancelJobsForPreview(preview.id)
    if (cancelledCount > 0) {
      logger.info("Cancelled pending jobs for deployment", {
        ...attrs,
        deploymentId: preview.id,
        cancelledCount,
      })
    }
  }

  // Fourth pass: queue plan jobs for root workspaces only
  // Non-root workspaces will have their jobs queued by the IaC engine
  // when their upstreams complete (via notifyDownstreams)
  const rootCount = previewData.filter((p) => p.isRoot).length
  logger.info("Queueing plan jobs for root workspaces", {
    ...attrs,
    rootCount,
    totalCount: previewData.length,
  })

  for (const { ws, preview, isRoot } of previewData) {
    if (isRoot) {
      // Queue plan job for root workspaces
      const job = await createIacJob({
        deploymentId: preview.id,
        jobType: "plan",
      })

      logger.info("Queued plan job for root workspace", {
        ...attrs,
        workspacePath: ws.path,
        deploymentId: preview.id,
        jobId: job.id,
      })

      // Update PR comment to show planning is queued
      await comment.update(ws.path, { phase: "planning" })
    } else {
      // Non-root workspaces start in pending state
      // They'll be queued when their upstreams complete
      logger.info("Workspace waiting for upstream dependencies", {
        ...attrs,
        workspacePath: ws.path,
        deploymentId: preview.id,
        upstreamCount: (workspaceDeps.get(ws.path) ?? new Set()).size,
      })
    }
  }

  // Emit event so UI picks up the queued state
  if (previewData.length > 0) {
    const first = previewData[0]
    events.emitDeploymentUpdate(
      first.preview.id,
      org.id,
      ctx.repo,
      "transient",
      environmentName,
    )
  }
}

/**
 * PR closed -- queue destroy jobs for all workspaces.
 * Whether merged or not, the preview gets destroyed.
 *
 * Destroy jobs are queued in reverse dependency order:
 * - Leaf workspaces (no downstreams) get destroy jobs queued immediately
 * - Non-leaf workspaces wait for their downstreams to be destroyed first
 * - The IaC engine handles cascading destroy via notifyDestroyComplete
 */
async function handlePrClosed(
  ctx: PullRequestContext,
  _runner: Runner, // Kept for API compatibility; execution now happens via IaC engine
  configLoader: ConfigLoader,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  const attrs = contextAttrs(ctx)
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId, ctx.installationId)

  // Load config to know which workspaces to destroy
  let config: YaffleTomlConfig
  try {
    const installationToken = await acquireToken(ctx)
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    await surfaceConfigError(ctx, msg)
    return
  }

  // Get workspaces that apply to transient environments
  const environmentName = buildPrEnvironmentName(ctx.prNumber)
  const workspacePaths = getWorkspacesForEnvironment(config, environmentName, true)

  if (workspacePaths.length === 0) {
    logger.info("no workspaces configured for transient environments", attrs)
    return
  }

  logger.info(
    `config loaded: ${workspacePaths.length} workspace(s) for PR destroy [${workspacePaths.join(", ")}]`,
    { ...attrs, "yaffle.workspace_count": workspacePaths.length },
  )

  // Get all deployments for this PR environment
  const deployments = await findDeploymentsByEnvironment(org.id, ctx.repo, environmentName)

  if (deployments.length === 0) {
    logger.info("no deployments found for this PR, nothing to destroy", attrs)
    return
  }

  const usingTfcBackend = useTfcBackend()

  // If using TFC backend, get TFC workspaces to archive
  const tfcWorkspacesToArchive = usingTfcBackend
    ? await getWorkspacesToArchive(org.id, ctx.repo, ctx.prNumber)
    : []

  // Identify leaf deployments (those with no downstream dependencies within this PR)
  // A deployment is a leaf if no other deployment in this PR has it in their upstreamIds
  const leafDeployments = deployments.filter((d) => {
    const hasDownstreams = deployments.some((other) =>
      other.upstreamIds?.includes(d.id),
    )
    return !hasDownstreams
  })

  logger.info("Identified leaf deployments for destroy", {
    ...attrs,
    totalDeployments: deployments.length,
    leafCount: leafDeployments.length,
    leafPaths: leafDeployments.map((d) => d.workspacePath),
  })

  // Process each deployment: cancel pending jobs, lock TFC workspace, queue destroy
  for (const deployment of deployments) {
    const wsAttrs = { ...attrs, "yaffle.workspace_path": deployment.workspacePath, deploymentId: deployment.id }

    // Cancel any pending plan/apply jobs for this deployment
    const cancelledCount = await cancelJobsForPreview(deployment.id)
    if (cancelledCount > 0) {
      logger.info(`cancelled ${cancelledCount} pending job(s)`, wsAttrs)
    }

    // Lock TFC workspace if using TFC backend
    const tfcWorkspace = tfcWorkspacesToArchive.find(
      (w) => w.workspacePath === deployment.workspacePath,
    )

    if (tfcWorkspace) {
      const locked = await beginWorkspaceArchive(tfcWorkspace.id)
      if (!locked) {
        logger.warn("Could not lock TFC workspace for archive, skipping destroy", {
          ...wsAttrs,
          tfcWorkspaceId: tfcWorkspace.id,
        })
        continue
      }
    }

    // Set deployment to pending state (waiting for destroy job)
    await updateDeploymentStatus(deployment.id, "pending")

    // Only queue destroy jobs for leaf deployments
    // Non-leaf deployments will have their destroy jobs queued by the IaC engine
    // when all their downstreams complete (via notifyDestroyComplete)
    const isLeaf = leafDeployments.some((leaf) => leaf.id === deployment.id)

    if (isLeaf) {
      const job = await createIacJob({
        deploymentId: deployment.id,
        jobType: "destroy",
      })

      logger.info("Queued destroy job for leaf deployment", {
        ...wsAttrs,
        jobId: job.id,
      })
    } else {
      logger.info("Deployment waiting for downstream destroys", {
        ...wsAttrs,
        upstreamIds: deployment.upstreamIds,
      })
    }
  }

  // Emit event so UI sees the queued state
  if (deployments.length > 0) {
    const first = deployments[0]
    events.emitDeploymentUpdate(
      first.id,
      org.id,
      ctx.repo,
      "transient",
      environmentName,
    )
  }
}

// ---------------------------------------------------------------------------
// Push events (production apply)
// ---------------------------------------------------------------------------

/**
 * Push event (production deploy) -- set up DAG, queue plan jobs for root workspaces.
 *
 * Like PR handling, this no longer executes plans inline.
 */
async function handlePushEvent(
  ctx: PushContext,
  _runner: Runner, // Kept for API compatibility; execution now happens via IaC engine
  configLoader: ConfigLoader,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}@${ctx.ref}`
  const attrs = contextAttrs(ctx)
  logger.info(`handling push event: ${tag} sha=${ctx.headSha}`, attrs)

  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId, ctx.installationId)
  const installationToken = await acquireToken(ctx)

  // Load config -- no PR to annotate on push events, just log
  let config: YaffleTomlConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    return
  }

  // Check if this ref matches any push trigger
  const environmentName = findPushTriggerEnvironment(config, ctx.ref)
  if (!environmentName) {
    logger.info(
      `ignoring push to ref that doesn't match any trigger`,
      { ...attrs, ref: ctx.ref },
    )
    return
  }

  // Get workspaces that apply to this named environment
  const workspacePaths = getWorkspacesForEnvironment(config, environmentName, false)

  if (workspacePaths.length === 0) {
    logger.info("no workspaces configured for this environment", {
      ...attrs,
      environmentName,
    })
    return
  }

  const activeWorkspaces = config.workspaces.filter((ws) => workspacePaths.includes(ws.path))

  const wsPaths = workspacePaths.join(", ")
  logger.info(
    `config loaded: ${workspacePaths.length} workspace(s) for ${environmentName} [${wsPaths}]`,
    { ...attrs, "yaffle.workspace_count": workspacePaths.length, environmentName },
  )

  const statePrefix = environmentStatePrefix(environmentName)

  // Create a single run group for this push event (covers both plan and apply)
  // Push events to the default branch are "named" environments (e.g., "main", "production")
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: ctx.repo,
    environmentKind: "named",
    environmentName,
    prNumber: null, // null for branch/env runs
    ref: ctx.ref,
    headSha: ctx.headSha,
    trigger: "push",
    status: "pending",
  })

  // Scan dependencies and compute execution order
  const activeWorkspacePaths = activeWorkspaces.map((ws) => ws.path)
  let executionOrder: string[]
  let dependencyGraph: SerializableDependencyGraph

  try {
    const scanResult = await scanDependencies(ctx, org.slug, org.id, activeWorkspacePaths, installationToken)
    executionOrder = scanResult.executionOrder
    dependencyGraph = scanResult.graph

    // Store the dependency graph in the run group for UI
    await updateRunGroupDependencyGraph(runGroup.id, dependencyGraph)

    // Store the workspace S3 key in the run group for runners
    if (scanResult.workspaceS3Key) {
      await updateRunGroupWorkspaceS3Key(runGroup.id, scanResult.workspaceS3Key)
    }

    logger.info("Execution order determined", {
      ...attrs,
      "yaffle.execution_order": executionOrder,
    })
  } catch (err) {
    // If dependency scan fails, fall back to config order
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`Dependency scan failed, using config order: ${msg}`, attrs)
    executionOrder = activeWorkspacePaths
    dependencyGraph = { workspaces: activeWorkspacePaths, edges: [] }
  }

  // Create a map for quick workspace lookup by path
  const workspaceByPath = new Map(activeWorkspaces.map((ws) => [ws.path, ws]))

  // Build dependency maps
  const workspaceDeps = new Map<string, Set<string>>()
  for (const [downstream, upstream] of dependencyGraph.edges) {
    if (!workspaceDeps.has(downstream)) {
      workspaceDeps.set(downstream, new Set())
    }
    workspaceDeps.get(downstream)!.add(upstream)
  }

  // First pass: upsert all previews with run_group_id
  const pathToPreviewId = new Map<string, string>()
  const previewData: Array<{
    ws: typeof config.workspaces[0]
    preview: { id: string }
    stateKey: string
    isRoot: boolean
  }> = []

  for (const wsPath of executionOrder) {
    const ws = workspaceByPath.get(wsPath)
    if (!ws) continue

    const stateKey = buildStateKey(statePrefix, ws.path)
    const upstreamPaths = workspaceDeps.get(ws.path) ?? new Set()
    const isRoot = upstreamPaths.size === 0

    // Resolve approvers from approval rules
    const approvers = resolveApprovers(config, ws.path, environmentName)
    const requireApproval = approvers.length > 0

    const preview = await upsertDeployment({
      orgId: org.id,
      installationId: ctx.installationId,
      repo: ctx.repo,
      environmentKind: "named",
      environmentName,
      prNumber: null, // null for branch/env runs
      workspacePath: ws.path,
      ref: ctx.ref,
      headSha: ctx.headSha,
      authorGithubId: ctx.pusherGithubId ?? undefined,
      authorLogin: ctx.pusherLogin ?? undefined,
      stateKey,
      mode: "terraform",
      requireApproval,
      approvers: approvers.length > 0 ? approvers : null,
      runGroupId: runGroup.id,
    })

    pathToPreviewId.set(ws.path, preview.id)
    previewData.push({ ws, preview, stateKey, isRoot })
  }

  // Second pass: set upstream_ids on each preview
  for (const { ws, preview } of previewData) {
    const upstreamPaths = workspaceDeps.get(ws.path) ?? new Set()
    if (upstreamPaths.size > 0) {
      const upstreamIds = [...upstreamPaths]
        .map((path) => pathToPreviewId.get(path))
        .filter((id): id is string => id !== undefined)

      await setDeploymentUpstreams(preview.id, upstreamIds)

      logger.info("Set upstream dependencies for production deployment", {
        deploymentId: preview.id,
        workspacePath: ws.path,
        upstreamIds,
      })
    }
  }

  // Third pass: queue plan jobs for root workspaces only
  const rootCount = previewData.filter((p) => p.isRoot).length
  logger.info("Queueing plan jobs for root production workspaces", {
    ...attrs,
    rootCount,
    totalCount: previewData.length,
  })

  for (const { ws, preview, isRoot } of previewData) {
    if (isRoot) {
      const job = await createIacJob({
        deploymentId: preview.id,
        jobType: "plan",
      })

      logger.info("Queued plan job for root production workspace", {
        ...attrs,
        workspacePath: ws.path,
        deploymentId: preview.id,
        jobId: job.id,
      })
    } else {
      logger.info("Production workspace waiting for upstream dependencies", {
        ...attrs,
        workspacePath: ws.path,
        deploymentId: preview.id,
        upstreamCount: (workspaceDeps.get(ws.path) ?? new Set()).size,
      })
    }
  }

  // Emit event so UI picks up the queued state
  if (previewData.length > 0) {
    const first = previewData[0]
    events.emitDeploymentUpdate(
      first.preview.id,
      org.id,
      ctx.repo,
      "named",
      environmentName,
    )
  }

  // Mark workspaces that are no longer in the config as destroyed
  const destroyedCount = await markRemovedWorkspacesDestroyed(
    org.id,
    ctx.repo,
    environmentName,
    ctx.headSha,
    workspacePaths,
  )

  if (destroyedCount > 0) {
    logger.info(`marked ${destroyedCount} removed workspace(s) as destroyed`, attrs)
  }
}



/**
 * Create a failed check run to surface a config error on a PR.
 * Only creates a check run for pull_request events with an installation.
 */
async function surfaceConfigError(
  ctx: WebhookContext,
  message: string,
): Promise<void> {
  if (ctx.kind !== "pull_request" || !ctx.installationId) return

  try {
    await createCheckRun(ctx.installationId, {
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      name: CHECK_NAME,
      status: "completed",
      conclusion: "failure",
      title: "Configuration error",
      summary: message,
    })
  } catch (err) {
    logger.warn("failed to create config error check run", {
      "yaffle.owner": ctx.owner,
      "yaffle.repo": ctx.repo,
      "error": err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Build a CheckRunRef from a context and check run ID, or undefined if
 * either the installation or check run ID is missing.
 *
 * Exported for use by IaC engine when creating check runs.
 */
export function makeCheckRunRef(
  ctx: WebhookContext,
  checkRunId: number | undefined,
): CheckRunRef | undefined {
  if (!checkRunId) return undefined
  return {
    id: checkRunId,
    url: checkRunUrl(ctx.owner, ctx.repo, checkRunId),
  }
}

/**
 * Acquire an installation token for private repo access.
 */
async function acquireToken(ctx: WebhookContext): Promise<string | undefined> {
  if (!ctx.installationId) return undefined
  try {
    return await getInstallationToken(ctx.installationId)
  } catch (err) {
    logger.warn("failed to get installation token", {
      "yaffle.owner": ctx.owner,
      "yaffle.repo": ctx.repo,
      "error": err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
