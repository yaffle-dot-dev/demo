import { SpanKind } from "@opentelemetry/api"

import type {
  PullRequestContext,
  PushContext,
  TerraformResult,
  WebhookContext,
} from "@yaffle/shared"

import {
  type YaffleConfig,
  ConfigError,
  interpolateVariables,
  parseYaml,
  prVariableContext,
  validateConfig,
} from "./config.ts"
// Note: executeApplyCallbacks is now called from iac-engine.ts
// import { executeApplyCallbacks } from "./apply-callbacks.ts"
import { ensureOrg } from "../db/queries/organizations.ts"
import { findPreview, findPreviewById, markRemovedWorkspacesDestroyed, setPreviewUpstreams, updatePreviewStatus, upsertPreview } from "../db/queries/previews.ts"
import { cancelJobsForPreview, createIacJob, findPendingJobsForPreview } from "../db/queries/iac-jobs.ts"
import { appendRunLog, createTfRun, findLatestRun, updateRunStatus } from "../db/queries/tf-runs.ts"
import { createRunGroup, updateRunGroupDependencyGraph, type RunGroupTrigger } from "../db/queries/run-groups.ts"
import { events } from "./events.ts"
import {
  createCheckRun,
  fetchFileContent,
  getInstallationToken,
  updateCheckRun,
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
  branchStatePrefix,
} from "./runner.ts"

import {
  beginWorkspaceArchive,
  completeWorkspaceArchive,
  failWorkspaceArchive,
  getWorkspacesToArchive,
} from "./workspace-service.ts"
import { useTfcBackend } from "./tfc-backend.ts"
import { generateRunToken } from "./run-token.ts"
import {
  SpanStatusCode,
  getConfigLoadErrorCounter,
  getRunDurationHistogram,
  getRunResultCounter,
  getRunQueueTimeHistogram,
  logger,
  withSpan,
} from "./telemetry.ts"
import { scanAllWorkspaceDependencies } from "./module-dependency-scanner.ts"
import { buildGraphFromInferred, type SerializableDependencyGraph } from "./dependency-graph.ts"
import { prepareWorkspace, cleanupWorkspace } from "./workspace.ts"

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
  return `${ctx.owner}/${ctx.repo}@${ctx.branch}`
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
    attrs["yaffle.branch"] = ctx.branch
  }
  return attrs
}

/**
 * Optional config loader override for testing.
 * In production, we fetch config via the GitHub API.
 * In tests, we inject a fake loader.
 */
type ConfigLoader = (ctx: WebhookContext, token?: string) => Promise<YaffleConfig>

/**
 * Result of scanning workspace dependencies and computing execution order.
 */
interface DependencyScanResult {
  /** Serializable graph for storage/UI */
  graph: SerializableDependencyGraph
  /** Workspace paths in topological execution order */
  executionOrder: string[]
}

/**
 * Scan repository for workspace dependencies and compute execution order.
 *
 * Clones the repo, scans all workspace directories for Yaffle module references,
 * builds a dependency graph, and returns the topological execution order.
 *
 * @param ctx - Webhook context with repo info
 * @param workspacePaths - List of workspace paths from config
 * @param installationToken - GitHub token for cloning
 * @returns Dependency graph and execution order
 */
async function scanDependencies(
  ctx: WebhookContext,
  workspacePaths: string[],
  installationToken?: string,
): Promise<DependencyScanResult> {
  return withSpan("scan_dependencies", async (span) => {
    span.setAttributes({
      "yaffle.workspace_count": workspacePaths.length,
    })

    // Clone repo to scan for dependencies
    let repoDir: string | undefined
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
    const preview = await findPreviewById(opts.previewId)
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
      const { recordPreviewApproval } = await import("../db/queries/previews.ts")
      await recordPreviewApproval(preview.id, opts.userId)

      // Also record in approvals table for audit trail
      if (preview.requireApproval) {
        const { createApproval } = await import("../db/queries/approvals.ts")
        await createApproval({
          previewId: preview.id,
          userId: opts.userId,
          approverLogin: opts.approverLogin ?? null,
        })
      }

      logger.info("Approval recorded", {
        previewId: preview.id,
        userId: opts.userId,
        approverLogin: opts.approverLogin ?? "unknown",
      })
    }

    // Queue apply job
    const job = await createIacJob({
      previewId: preview.id,
      jobType: "apply",
    })

    logger.info("Apply job queued", {
      previewId: preview.id,
      jobId: job.id,
      workspacePath: preview.workspacePath,
    })

    // Emit event so UI sees the job queued
    events.emitPreviewUpdate(preview.id, preview.orgId, preview.repo, preview.prNumber)

    return { applyStarted: true, jobId: job.id }
  })
}

/**
 * Manually re-run a preview (plan only - apply requires explicit approval).
 * This allows users to re-trigger a run without pushing new commits.
 *
 * The preview stays in its existing run group. We just reset status to pending
 * and queue a new plan job. The scheduler picks it up like any other job.
 */
export async function rerunPreview(opts: {
  previewId: string
  triggeredBy?: string | null
}): Promise<{ runGroupId: string; jobId: string }> {
  return previewMutex.run(`rerun:${opts.previewId}`, async () => {
    const preview = await findPreviewById(opts.previewId)
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
    const { updatePreviewStatus } = await import("../db/queries/previews.ts")
    await updatePreviewStatus(preview.id, "pending")

    // Queue a plan job - the scheduler will pick it up
    const job = await createIacJob({
      previewId: preview.id,
      jobType: "plan",
    })

    logger.info("Manual re-run queued", {
      previewId: opts.previewId,
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
async function fetchConfig(ctx: WebhookContext, _token?: string): Promise<YaffleConfig> {
  if (!ctx.installationId) {
    throw new ConfigError(
      "Cannot fetch config without a GitHub App installation",
    )
  }

  const raw = await fetchFileContent(
    ctx.installationId,
    ctx.owner,
    ctx.repo,
    ".yaffle/config.yml",
    ctx.headSha,
  )

  if (!raw) {
    throw new ConfigError(
      "No .yaffle/config.yml found. Yaffle requires a config file. See https://yaffle.dev/docs/config",
    )
  }

  const parsed = parseYaml(raw)
  return validateConfig(parsed)
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
  let config: YaffleConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    await surfaceConfigError(ctx, msg)
    return
  }

  const wsPaths = config.workspaces.map((ws) => ws.path).join(", ")
  logger.info(
    `config loaded: ${config.workspaces.length} workspace(s) [${wsPaths}]`,
    { ...attrs, "yaffle.workspace_count": config.workspaces.length },
  )

  const statePrefix = previewStatePrefix(ctx.prNumber)
  const comment = createCommentManager(ctx)

  // Create a single run group for this PR event (covers both plan and apply)
  const trigger: RunGroupTrigger = ctx.action === "opened" ? "pr_opened" : "pr_sync"
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    branch: ctx.branch,
    headSha: ctx.headSha,
    trigger,
    status: "pending",
  })

  // Scan dependencies and compute execution order
  const workspacePaths = config.workspaces.map((ws) => ws.path)
  let executionOrder: string[]
  let dependencyGraph: SerializableDependencyGraph

  try {
    const scanResult = await scanDependencies(ctx, workspacePaths, installationToken)
    executionOrder = scanResult.executionOrder
    dependencyGraph = scanResult.graph

    // Store the dependency graph in the run group for UI
    await updateRunGroupDependencyGraph(runGroup.id, dependencyGraph)

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
  const workspaceByPath = new Map(config.workspaces.map((ws) => [ws.path, ws]))

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

    // Upsert preview with run_group_id
    const preview = await upsertPreview({
      orgId: org.id,
      installationId: ctx.installationId,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      workspacePath: ws.path,
      branch: ctx.branch,
      headSha: ctx.headSha,
      authorGithubId: ctx.authorGithubId,
      authorLogin: ctx.authorLogin,
      stateKey,
      mode: "terraform",
      requireApproval: false,
      approvers: null,
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

      await setPreviewUpstreams(preview.id, upstreamIds)

      logger.info("Set upstream dependencies for preview", {
        previewId: preview.id,
        workspacePath: ws.path,
        upstreamIds,
      })
    }
  }

  // Third pass: queue plan jobs for root workspaces only
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
        previewId: preview.id,
        jobType: "plan",
      })

      logger.info("Queued plan job for root workspace", {
        ...attrs,
        workspacePath: ws.path,
        previewId: preview.id,
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
        previewId: preview.id,
        upstreamCount: (workspaceDeps.get(ws.path) ?? new Set()).size,
      })
    }
  }

  // Emit event so UI picks up the queued state
  if (previewData.length > 0) {
    const first = previewData[0]
    events.emitPreviewUpdate(first.preview.id, org.id, ctx.repo, ctx.prNumber)
  }
}

/**
 * PR closed -- destroy preview resources for all workspaces.
 * Whether merged or not, the preview gets destroyed.
 */
async function handlePrClosed(
  ctx: PullRequestContext,
  runner: Runner,
  configLoader: ConfigLoader,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  const attrs = contextAttrs(ctx)
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId, ctx.installationId)
  const installationToken = await acquireToken(ctx)

  // Load config to know which workspaces to destroy
  let config: YaffleConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    await surfaceConfigError(ctx, msg)
    return
  }

  const wsPaths = config.workspaces.map((ws) => ws.path).join(", ")
  logger.info(
    `config loaded: ${config.workspaces.length} workspace(s) [${wsPaths}]`,
    { ...attrs, "yaffle.workspace_count": config.workspaces.length },
  )

  const statePrefix = previewStatePrefix(ctx.prNumber)
  const varCtx = prVariableContext({
    prNumber: ctx.prNumber,
    branch: ctx.branch,
    sha: ctx.headSha,
    owner: ctx.owner,
    repo: ctx.repo,
  })
  const comment = createCommentManager(ctx)
  const usingTfcBackend = useTfcBackend()

  // If using TFC backend, also get TFC workspaces to archive
  const tfcWorkspacesToArchive = usingTfcBackend
    ? await getWorkspacesToArchive(org.id, ctx.repo, ctx.prNumber)
    : []

  for (const ws of config.workspaces) {
    await withSpan("workspace.destroy", async (wsSpan) => {
      const stateKey = buildStateKey(statePrefix, ws.path)
      const wsTag = `${tag}:${ws.path}`
      const wsAttrs = { ...attrs, "yaffle.workspace_path": ws.path, "yaffle.state_key": stateKey }
      wsSpan.setAttributes(wsAttrs)

      const preview = await findPreview(org.id, ctx.repo, ctx.prNumber, ws.path)
      if (!preview) {
        logger.warn("no preview found, nothing to destroy", wsAttrs)
        return
      }

      // Cancel any pending jobs for this preview
      const cancelledCount = await cancelJobsForPreview(preview.id)
      if (cancelledCount > 0) {
        logger.info(`cancelled ${cancelledCount} pending job(s)`, wsAttrs)
      }

      // Find corresponding TFC workspace if using TFC backend
      const tfcWorkspace = tfcWorkspacesToArchive.find(
        (w) => w.workspacePath === ws.path,
      )

      // Begin TFC workspace archive (locks the workspace)
      if (tfcWorkspace) {
        const locked = await beginWorkspaceArchive(tfcWorkspace.id)
        if (!locked) {
          logger.warn("Could not lock TFC workspace for archive, skipping destroy", {
            ...wsAttrs,
            tfcWorkspaceId: tfcWorkspace.id,
          })
          return
        }
      }

      // Generate TFC token for destroy if using TFC backend
      let tfcWorkspaceId: string | undefined
      let tfcWorkspaceName: string | undefined
      let tfcOrganization: string | undefined
      let tfcToken: string | undefined

      if (tfcWorkspace) {
        tfcWorkspaceId = tfcWorkspace.id
        tfcWorkspaceName = tfcWorkspace.name
        tfcOrganization = org.slug
        tfcToken = await generateRunToken(preview.id, tfcWorkspace.id, org.id)
      }

      const variables = interpolateVariables(ws.variables, varCtx)

      logger.info("destroying preview", wsAttrs)
      await updatePreviewStatus(preview.id, "destroying")
      await comment.update(ws.path, { phase: "destroying" })

      const destroyResult = await executeRun({
        ctx,
        preview,
        runner,
        command: "destroy",
        stateKey,
        workspacePath: ws.path,
        variables,
        installationToken,
        wsTag,
        tfcWorkspaceId,
        tfcWorkspaceName,
        tfcOrganization,
        tfcToken,
      })

      if (destroyResult.success) {
        await updatePreviewStatus(preview.id, "destroyed")
        await comment.update(ws.path, { phase: "destroyed" })

        // Archive TFC workspace
        if (tfcWorkspace) {
          await completeWorkspaceArchive(tfcWorkspace.id)
        }

        logger.info("preview destroyed", wsAttrs)
      } else {
        // Mark TFC workspace archive as failed
        if (tfcWorkspace) {
          await failWorkspaceArchive(
            tfcWorkspace.id,
            destroyResult.errorMessage ?? "terraform destroy failed",
          )
        }
      }
    })
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
  const tag = `${ctx.owner}/${ctx.repo}@${ctx.branch}`
  const attrs = contextAttrs(ctx)
  logger.info(`handling push event: ${tag} sha=${ctx.headSha}`, attrs)

  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId, ctx.installationId)
  const installationToken = await acquireToken(ctx)

  // Load config -- no PR to annotate on push events, just log
  let config: YaffleConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    return
  }

  const wsPaths = config.workspaces.map((ws) => ws.path).join(", ")
  logger.info(
    `config loaded: ${config.workspaces.length} workspace(s) [${wsPaths}]`,
    { ...attrs, "yaffle.workspace_count": config.workspaces.length },
  )

  // Determine default branch
  const defaultBranch = config.default_branch ?? ctx.defaultBranch
  if (ctx.branch !== defaultBranch) {
    logger.info(
      `ignoring push to non-default branch (default: ${defaultBranch})`,
      attrs,
    )
    return
  }

  const statePrefix = branchStatePrefix(ctx.branch)

  // Filter to workspaces that should run on push
  const activeWorkspaces = config.workspaces.filter(
    (ws) => ws.auto_apply_on_merge || ws.require_approval,
  )

  if (activeWorkspaces.length === 0) {
    logger.info("no workspaces configured for production deploy", attrs)
    return
  }

  // Create a single run group for this push event (covers both plan and apply)
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: ctx.repo,
    prNumber: null, // null for branch/env runs
    branch: ctx.branch,
    headSha: ctx.headSha,
    trigger: "push",
    status: "pending",
  })

  // Scan dependencies and compute execution order
  const activeWorkspacePaths = activeWorkspaces.map((ws) => ws.path)
  let executionOrder: string[]
  let dependencyGraph: SerializableDependencyGraph

  try {
    const scanResult = await scanDependencies(ctx, activeWorkspacePaths, installationToken)
    executionOrder = scanResult.executionOrder
    dependencyGraph = scanResult.graph

    // Store the dependency graph in the run group for UI
    await updateRunGroupDependencyGraph(runGroup.id, dependencyGraph)

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

    const preview = await upsertPreview({
      orgId: org.id,
      installationId: ctx.installationId,
      repo: ctx.repo,
      prNumber: 0,
      workspacePath: ws.path,
      branch: ctx.branch,
      headSha: ctx.headSha,
      authorGithubId: ctx.pusherGithubId ?? undefined,
      authorLogin: ctx.pusherLogin ?? undefined,
      stateKey,
      mode: "terraform",
      requireApproval: ws.require_approval ?? false,
      approvers: ws.approvers ?? null,
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

      await setPreviewUpstreams(preview.id, upstreamIds)

      logger.info("Set upstream dependencies for production preview", {
        previewId: preview.id,
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
        previewId: preview.id,
        jobType: "plan",
      })

      logger.info("Queued plan job for root production workspace", {
        ...attrs,
        workspacePath: ws.path,
        previewId: preview.id,
        jobId: job.id,
      })
    } else {
      logger.info("Production workspace waiting for upstream dependencies", {
        ...attrs,
        workspacePath: ws.path,
        previewId: preview.id,
        upstreamCount: (workspaceDeps.get(ws.path) ?? new Set()).size,
      })
    }
  }

  // Emit event so UI picks up the queued state
  if (previewData.length > 0) {
    const first = previewData[0]
    events.emitPreviewUpdate(first.preview.id, org.id, ctx.repo, 0)
  }

  // Mark workspaces that are no longer in the config as destroyed
  const configWorkspacePaths = config.workspaces
    .filter((ws) => ws.auto_apply_on_merge || ws.require_approval)
    .map((ws) => ws.path)

  const destroyedCount = await markRemovedWorkspacesDestroyed(
    org.id,
    ctx.repo,
    ctx.branch,
    ctx.headSha,
    configWorkspacePaths,
  )

  if (destroyedCount > 0) {
    logger.info(`marked ${destroyedCount} removed workspace(s) as destroyed`, attrs)
  }
}

// ---------------------------------------------------------------------------
// Shared execution logic
// ---------------------------------------------------------------------------

/**
 * Execute a single terraform run, creating DB records and updating
 * GitHub check runs.
 */
/** TerraformResult extended with the check run ID created for this run. */
type RunResult = TerraformResult & { checkRunId?: number }

async function executeRun(opts: {
  ctx: WebhookContext
  preview: { id: string }
  runner: Runner
  command: "plan" | "apply" | "destroy"
  stateKey: string
  workspacePath: string
  variables: Record<string, string | boolean>
  installationToken?: string
  wsTag: string
  createCheckRun?: boolean
  checkRunId?: number // Existing check run to update (instead of creating new)
  existingRunId?: string // Use existing run record instead of creating new
  runGroupId?: string // Run group this run belongs to
  // TFC backend options (when YAFFLE_TFC_API_HOST is set)
  tfcWorkspaceId?: string
  tfcWorkspaceName?: string
  tfcOrganization?: string
  tfcToken?: string
}): Promise<RunResult> {
  return withSpan(`run.${opts.command}`, async (span) => {
    const { ctx, preview, runner } = opts
    const runAttrs = {
      "yaffle.command": opts.command,
      "yaffle.workspace_path": opts.workspacePath,
      "yaffle.state_key": opts.stateKey,
      "yaffle.owner": ctx.owner,
      "yaffle.repo": ctx.repo,
      "yaffle.ws_tag": opts.wsTag,
    }
    span.setAttributes(runAttrs)

    // Use existing run or create new one
    const runCreatedAt = Date.now()
    const run = opts.existingRunId
      ? { id: opts.existingRunId, previewId: preview.id }
      : await createTfRun({
          previewId: preview.id,
          runGroupId: opts.runGroupId,
          runType: opts.command,
          status: "pending",
        })

    // Use existing check run or create a new one
    let checkRunId: number | undefined = opts.checkRunId
    if (!checkRunId && ctx.installationId && (ctx.kind === "pull_request" || opts.createCheckRun)) {
      const checkName = opts.workspacePath === "."
        ? CHECK_NAME
        : `${CHECK_NAME} (${opts.workspacePath})`

      try {
          checkRunId = await createCheckRun(ctx.installationId, {
            owner: ctx.owner,
            repo: ctx.repo,
            headSha: ctx.headSha,
            name: checkName,
            status: "in_progress",
            title: `Running ${opts.command}`,
            summary: `${opts.command} for ${opts.workspacePath}...`,
          })
      } catch (err) {
        logger.warn("failed to create check run", {
          ...runAttrs,
          "error": err instanceof Error ? err.message : String(err),
        })
      }
    }

    const runStartedAt = Date.now()
    const queueTimeMs = runStartedAt - runCreatedAt
    getRunQueueTimeHistogram().record(queueTimeMs, {
      command: opts.command,
      workspace: opts.workspacePath,
    })
    span.setAttributes({ "yaffle.run.queue_time_ms": queueTimeMs })

    await updateRunStatus(run.id, preview.id, "running", {
      checkRunId,
      startedAt: new Date(),
    })

    // Execute
    let result: TerraformResult
    let logBuffer = ""
    let flushing: Promise<void> | null = null
    let flushInterval: ReturnType<typeof setInterval> | null = null

    const flushLogs = async (): Promise<void> => {
      if (!logBuffer) return
      const chunk = logBuffer
      logBuffer = ""
      try {
        await appendRunLog(run.id, preview.id, chunk)
      } catch (err) {
        logger.warn("failed to append run logs", {
          ...runAttrs,
          "error": err instanceof Error ? err.message : String(err),
        })
      }
    }
    try {
      // Flush logs frequently for smooth streaming (100ms interval)
      flushInterval = setInterval(() => {
        if (!flushing) {
          flushing = flushLogs().finally(() => {
            flushing = null
          })
        }
      }, 100)

      result = await runner.run({
        owner: ctx.owner,
        repo: ctx.repo,
        headSha: ctx.headSha,
        command: opts.command,
        workspacePath: opts.workspacePath,
        stateKey: opts.stateKey,
        variables: opts.variables,
        installationToken: opts.installationToken,
        // Yaffle context for provider tags
        runId: run.id,
        prNumber: ctx.kind === "pull_request" ? ctx.prNumber : undefined,
        // TFC backend options
        tfcWorkspaceId: opts.tfcWorkspaceId,
        tfcWorkspaceName: opts.tfcWorkspaceName,
        tfcOrganization: opts.tfcOrganization,
        tfcToken: opts.tfcToken,
        onOutput: (chunk, source) => {
          const entry = source === "stderr" ? `[stderr] ${chunk}` : chunk
          logBuffer += entry
          // Flush immediately on larger chunks for smooth streaming
          if (logBuffer.length > 512 && !flushing) {
            flushing = flushLogs().finally(() => {
              flushing = null
            })
          }
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`${opts.command} threw: ${msg}`, runAttrs)
      span.setStatus({ code: SpanStatusCode.ERROR, message: msg })
      span.recordException(err instanceof Error ? err : new Error(msg))

      result = {
        success: false,
        command: opts.command,
        output: "",
        errorMessage: msg,
        durationMs: 0,
      }
    }

    if (flushInterval) {
      clearInterval(flushInterval)
    }

    if (flushing) {
      await flushing
    }
    await flushLogs()

    // Record metrics
    getRunDurationHistogram().record(result.durationMs, {
      command: opts.command,
      workspace: opts.workspacePath,
      success: String(result.success),
    })
    getRunResultCounter().add(1, {
      command: opts.command,
      workspace: opts.workspacePath,
      result: result.success ? "success" : "failure",
    })

    // Update span with result
    span.setAttributes({
      "yaffle.run.success": result.success,
      "yaffle.run.duration_ms": result.durationMs,
    })

    // Update DB
    if (result.success) {
      await updateRunStatus(run.id, preview.id, "success", {
        completedAt: new Date(),
        planSummary: result.planSummary,
        planJson: result.planJson,
        outputs: result.outputs,
      })
    } else {
      await updateRunStatus(run.id, preview.id, "failed", {
        completedAt: new Date(),
        errorMessage: result.errorMessage,
      })
      await updatePreviewStatus(preview.id, "failed")
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: result.errorMessage ?? `${opts.command} failed`,
      })
    }

    logger.info(
      `${opts.command}: success=${result.success} duration=${result.durationMs}ms`,
      runAttrs,
    )

    // Update check run
    if (checkRunId && ctx.installationId) {
      const MAX_TEXT_LENGTH = 65000
      let text = result.output
      if (text.length > MAX_TEXT_LENGTH) {
        text = `${text.slice(0, MAX_TEXT_LENGTH)}\n\n... (output truncated)`
      }
      const formattedText = text ? `\`\`\`\n${text}\n\`\`\`` : undefined

      await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, checkRunId, {
        status: "completed",
        conclusion: result.success ? "success" : "failure",
        title: result.success
          ? opts.command === "plan"
            ? `Plan: ${result.planSummary ?? "complete"}`
            : `${opts.command} complete`
          : `${opts.command} failed`,
        summary: result.success
          ? opts.command === "plan"
            ? `Plan: ${result.planSummary ?? "complete"}`
            : `${opts.command} completed successfully`
          : (result.errorMessage ?? `${opts.command} failed`),
        text: formattedText,
      }).catch((err) => logger.warn("failed to update check run", {
        ...runAttrs,
        "error": err instanceof Error ? err.message : String(err),
      }))
    }

    return { ...result, checkRunId }
  })
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
