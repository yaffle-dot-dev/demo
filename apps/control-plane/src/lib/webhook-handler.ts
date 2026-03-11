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
  pushVariableContext,
  validateConfig,
} from "./config.ts"
import { executeApplyCallbacks } from "./apply-callbacks.ts"
import { ensureOrg, findGithubInstallationsForOrg } from "../db/queries/organizations.ts"
import { findPreview, findPreviewById, markRemovedWorkspacesDestroyed, updatePreviewStatus, upsertPreview } from "../db/queries/previews.ts"
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
  ensurePreviewWorkspace,
  ensureProductionWorkspace,
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
 * Approve a production preview and apply.
 */
export async function approvePreviewApply(opts: {
  previewId: string
  approverLogin?: string | null
}): Promise<void> {
  return previewMutex.run(`approve:${opts.previewId}`, async () => {
    const preview = await findPreviewById(opts.previewId)
    if (!preview) {
      throw new Error("preview not found")
    }
    if (!preview.requireApproval) {
      throw new Error("approval not required")
    }
    if (preview.status !== "awaiting_approval") {
      throw new Error("preview is not awaiting approval")
    }
    if (!preview.installationId) {
      throw new Error("missing installation id")
    }

    const approvers = Array.isArray(preview.approvers) ? preview.approvers : []
    if (
      approvers.length > 0 &&
      opts.approverLogin &&
      !approvers.map((a) => a.toLowerCase()).includes(opts.approverLogin.toLowerCase())
    ) {
      throw new Error("approver not authorized")
    }

    // Get the GitHub org info from the installation
    const installations = await findGithubInstallationsForOrg(preview.orgId)
    const installation = installations.find((i) => i.installationId === preview.installationId)
    if (!installation) {
      throw new Error("github installation not found for this preview")
    }

    const ctx: PushContext = {
      kind: "push",
      installationId: preview.installationId,
      ownerGithubId: installation.githubOrgId,
      owner: installation.githubOrgLogin,
      repo: preview.repo,
      headSha: preview.headSha,
      branch: preview.branch,
      // Synthetic context for destroy - no pusher info available
      pusherGithubId: null,
      pusherLogin: null,
      defaultBranch: preview.branch,
    }

    const raw = await fetchFileContent(
      preview.installationId,
      ctx.owner,
      ctx.repo,
      ".yaffle/config.yml",
      ctx.headSha,
    )
    if (!raw) {
      throw new Error("config file not found")
    }
    const config = validateConfig(parseYaml(raw))
    const workspace = config.workspaces.find((ws) => ws.path === preview.workspacePath)
    if (!workspace) {
      throw new Error("workspace not found in config")
    }

    const variables = interpolateVariables(
      workspace.variables,
      pushVariableContext({
        branch: preview.branch,
        sha: preview.headSha,
        owner: ctx.owner,
        repo: ctx.repo,
      }),
    )

    const installationToken = await getInstallationToken(preview.installationId)

    // TFC backend: get or create production workspace and generate run token
    let tfcWorkspaceId: string | undefined
    let tfcWorkspaceName: string | undefined
    let tfcOrganization: string | undefined
    let tfcToken: string | undefined

    if (useTfcBackend()) {
      const { findOrgById } = await import("../db/queries/organizations.ts")
      const org = await findOrgById(preview.orgId)
      if (org) {
        const tfcWorkspace = await ensureProductionWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: preview.repo,
          branch: preview.branch,
          workspacePath: preview.workspacePath,
        })
        tfcWorkspaceId = tfcWorkspace.id
        tfcWorkspaceName = tfcWorkspace.name
        tfcOrganization = org.slug
        tfcToken = await generateRunToken(preview.id, tfcWorkspace.id, org.id)
      }
    }

    const planRun = await findLatestRun(preview.id, "plan")
    if (planRun?.checkRunId) {
      await updateCheckRun(preview.installationId, ctx.owner, ctx.repo, planRun.checkRunId, {
        status: "in_progress",
        title: "Applying after approval",
        summary: opts.approverLogin ? `Approved by @${opts.approverLogin}` : "Approved",
      })
    }

    await updatePreviewStatus(preview.id, "applying")

    const applyResult = await executeRun({
      ctx,
      preview,
      runner: defaultRunner,
      command: "apply",
      stateKey: preview.stateKey,
      workspacePath: preview.workspacePath,
      variables,
      installationToken,
      wsTag: `${ctx.owner}/${ctx.repo}@${ctx.branch}:${preview.workspacePath}`,
      tfcWorkspaceId,
      tfcWorkspaceName,
      tfcOrganization,
      tfcToken,
    })

    if (applyResult.success) {
      await updatePreviewStatus(preview.id, "ready")

      // Execute apply callbacks (webhooks, github_dispatch)
      if (workspace.on_apply && applyResult.outputs) {
        await executeApplyCallbacks(workspace.on_apply, {
          owner: ctx.owner,
          repo: ctx.repo,
          prNumber: 0, // Production
          branch: ctx.branch,
          headSha: ctx.headSha,
          workspacePath: preview.workspacePath,
          previewId: preview.id,
          outputs: applyResult.outputs,
        }, ctx.installationId)
      }
    }

    if (planRun?.checkRunId) {
      await updateCheckRun(preview.installationId, ctx.owner, ctx.repo, planRun.checkRunId, {
        status: "completed",
        conclusion: applyResult.success ? "success" : "failure",
        title: applyResult.success ? "Applied" : "Apply failed",
        summary: applyResult.success
          ? "Production apply completed."
          : applyResult.errorMessage ?? "Apply failed.",
      })
    }
  })
}

/**
 * Manually re-run a preview (plan + apply if auto-apply is enabled).
 * This allows users to re-trigger a run without pushing new commits.
 */
export async function rerunPreview(opts: {
  previewId: string
  triggeredBy?: string | null
}): Promise<{ runGroupId: string }> {
  return previewMutex.run(`rerun:${opts.previewId}`, async () => {
    const preview = await findPreviewById(opts.previewId)
    if (!preview) {
      throw new Error("preview not found")
    }
    if (!preview.installationId) {
      throw new Error("missing installation id")
    }

    // Don't allow re-run if there's already a run in progress
    const latestPlan = await findLatestRun(preview.id, "plan")
    const latestApply = await findLatestRun(preview.id, "apply")
    const isRunning = (latestPlan?.status === "pending" || latestPlan?.status === "running") ||
                      (latestApply?.status === "pending" || latestApply?.status === "running")
    if (isRunning) {
      throw new Error("a run is already in progress")
    }

    // Get the GitHub org info from the installation
    const installations = await findGithubInstallationsForOrg(preview.orgId)
    const installation = installations.find((i) => i.installationId === preview.installationId)
    if (!installation) {
      throw new Error("github installation not found for this preview")
    }

    const { findOrgById } = await import("../db/queries/organizations.ts")
    const org = await findOrgById(preview.orgId)
    if (!org) {
      throw new Error("organization not found")
    }

    // Build context based on whether this is a PR or production preview
    const isPr = preview.prNumber !== 0

    const ctx: PullRequestContext | PushContext = isPr
      ? {
          kind: "pull_request",
          installationId: preview.installationId,
          ownerGithubId: installation.githubOrgId,
          owner: installation.githubOrgLogin,
          repo: preview.repo,
          prNumber: preview.prNumber,
          action: "synchronize", // Treat re-run like a sync
          branch: preview.branch,
          headSha: preview.headSha,
          authorGithubId: preview.authorGithubId ?? 0, // 0 for unknown author
          authorLogin: preview.authorLogin ?? "unknown",
          merged: false,
          defaultBranch: preview.branch, // Best guess for re-runs
        }
      : {
          kind: "push",
          installationId: preview.installationId,
          ownerGithubId: installation.githubOrgId,
          owner: installation.githubOrgLogin,
          repo: preview.repo,
          headSha: preview.headSha,
          branch: preview.branch,
          pusherGithubId: null,
          pusherLogin: opts.triggeredBy ?? null,
          defaultBranch: preview.branch,
        }

    // Fetch and validate config
    const raw = await fetchFileContent(
      preview.installationId,
      ctx.owner,
      ctx.repo,
      ".yaffle/config.yml",
      ctx.headSha,
    )
    if (!raw) {
      throw new Error("config file not found")
    }
    const config = validateConfig(parseYaml(raw))
    const workspace = config.workspaces.find((ws) => ws.path === preview.workspacePath)
    if (!workspace) {
      throw new Error("workspace not found in config")
    }

    // Create run group with manual trigger
    const runGroup = await createRunGroup({
      orgId: org.id,
      repo: preview.repo,
      prNumber: preview.prNumber,
      branch: preview.branch,
      headSha: preview.headSha,
      trigger: "manual",
      status: "pending",
    })

    // Create pending plan run
    const pendingRun = await createTfRun({
      previewId: preview.id,
      runGroupId: runGroup.id,
      runType: "plan",
      status: "pending",
    })

    // Emit update so UI sees the pending run immediately
    events.emitRunUpdate(pendingRun.id, preview.id)

    // Execute the run asynchronously (don't await - return immediately)
    // This mirrors how webhook events work: we acknowledge the request
    // and process in the background
    executeManualRun({
      ctx,
      preview,
      workspace,
      config,
      org,
      runGroup,
      pendingRunId: pendingRun.id,
    }).catch((err) => {
      logger.error("Manual re-run failed", {
        previewId: opts.previewId,
        runGroupId: runGroup.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    return { runGroupId: runGroup.id }
  })
}

/**
 * Execute the actual plan/apply for a manual re-run.
 * This runs asynchronously after the API returns.
 */
async function executeManualRun(opts: {
  ctx: PullRequestContext | PushContext
  preview: Awaited<ReturnType<typeof findPreviewById>> & { id: string }
  workspace: YaffleConfig["workspaces"][0]
  config: YaffleConfig
  org: { id: string; slug: string }
  runGroup: { id: string }
  pendingRunId: string
}): Promise<void> {
  const { ctx, preview, workspace, org, runGroup, pendingRunId } = opts
  const isPr = ctx.kind === "pull_request"

  const installationToken = await getInstallationToken(ctx.installationId)

  // Build variables
  const variables = isPr
    ? interpolateVariables(
        workspace.variables,
        prVariableContext({
          prNumber: (ctx as PullRequestContext).prNumber,
          branch: ctx.branch,
          sha: ctx.headSha,
          owner: ctx.owner,
          repo: ctx.repo,
        }),
      )
    : interpolateVariables(
        workspace.variables,
        pushVariableContext({
          branch: ctx.branch,
          sha: ctx.headSha,
          owner: ctx.owner,
          repo: ctx.repo,
        }),
      )

  const stateKey = preview.stateKey
  const wsTag = `${ctx.owner}/${ctx.repo}${isPr ? `#${(ctx as PullRequestContext).prNumber}` : `@${ctx.branch}`}:${preview.workspacePath}`

  // TFC backend setup
  let tfcWorkspaceId: string | undefined
  let tfcWorkspaceName: string | undefined
  let tfcOrganization: string | undefined
  let tfcToken: string | undefined

  if (useTfcBackend()) {
    const tfcWorkspace = isPr
      ? await ensurePreviewWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: preview.repo,
          prNumber: (ctx as PullRequestContext).prNumber,
          workspacePath: preview.workspacePath,
          branch: ctx.branch,
        })
      : await ensureProductionWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: preview.repo,
          branch: ctx.branch,
          workspacePath: preview.workspacePath,
        })
    tfcWorkspaceId = tfcWorkspace.id
    tfcWorkspaceName = tfcWorkspace.name
    tfcOrganization = org.slug
    tfcToken = await generateRunToken(preview.id, tfcWorkspace.id, org.id)
  }

  // Update preview status
  await updatePreviewStatus(preview.id, "planning")

  // Execute plan
  const planResult = await executeRun({
    ctx,
    preview,
    runner: defaultRunner,
    command: "plan",
    stateKey,
    workspacePath: preview.workspacePath,
    variables,
    installationToken,
    wsTag,
    tfcWorkspaceId,
    tfcWorkspaceName,
    tfcOrganization,
    tfcToken,
    existingRunId: pendingRunId,
    runGroupId: runGroup.id,
  })

  if (!planResult.success) {
    await updatePreviewStatus(preview.id, "failed")
    return
  }

  // Check if we should auto-apply
  const hasChanges = planResult.planSummary !== "no changes"
  const shouldApply = isPr // PR previews auto-apply, production requires approval

  if (!hasChanges) {
    // No changes - create skipped apply and mark as ready
    await createTfRun({
      previewId: preview.id,
      runGroupId: runGroup.id,
      runType: "apply",
      status: "skipped",
    })
    await updatePreviewStatus(preview.id, "ready")
    return
  }

  if (shouldApply) {
    // Create apply run and execute
    const applyRun = await createTfRun({
      previewId: preview.id,
      runGroupId: runGroup.id,
      runType: "apply",
      status: "pending",
    })
    events.emitRunUpdate(applyRun.id, preview.id)

    await updatePreviewStatus(preview.id, "applying")

    const applyResult = await executeRun({
      ctx,
      preview,
      runner: defaultRunner,
      command: "apply",
      stateKey,
      workspacePath: preview.workspacePath,
      variables,
      installationToken,
      wsTag,
      tfcWorkspaceId,
      tfcWorkspaceName,
      tfcOrganization,
      tfcToken,
      existingRunId: applyRun.id,
      runGroupId: runGroup.id,
    })

    await updatePreviewStatus(preview.id, applyResult.success ? "ready" : "failed")

    // Execute apply callbacks
    if (applyResult.success && workspace.on_apply && applyResult.outputs) {
      await executeApplyCallbacks(workspace.on_apply, {
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: isPr ? (ctx as PullRequestContext).prNumber : 0,
        branch: ctx.branch,
        headSha: ctx.headSha,
        workspacePath: preview.workspacePath,
        previewId: preview.id,
        outputs: applyResult.outputs,
      }, ctx.installationId)
    }
  } else {
    // Production preview - requires approval
    await updatePreviewStatus(preview.id, "awaiting_approval")
  }
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
 * PR opened/updated -- load config, then plan + apply per workspace.
 */
async function handlePrOpenedOrUpdated(
  ctx: PullRequestContext,
  runner: Runner,
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
  const varCtx = prVariableContext({
    prNumber: ctx.prNumber,
    branch: ctx.branch,
    sha: ctx.headSha,
    owner: ctx.owner,
    repo: ctx.repo,
  })

  const comment = createCommentManager(ctx)
  const usingTfcBackend = useTfcBackend()

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

  // First pass: upsert all previews and create pending runs upfront
  // This ensures all workspaces appear in the UI immediately
  const workspaceData: Array<{
    ws: typeof config.workspaces[0]
    preview: { id: string }
    pendingRunId: string
    stateKey: string
    wsTag: string
  }> = []

  // Iterate in execution order (topological)
  for (const wsPath of executionOrder) {
    const ws = workspaceByPath.get(wsPath)
    if (!ws) continue // Skip if not in config (shouldn't happen)
    const stateKey = buildStateKey(statePrefix, ws.path)
    const wsTag = `${tag}:${ws.path}`

    // Upsert preview
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
    })

    // Create pending run record upfront
    const pendingRun = await createTfRun({
      previewId: preview.id,
      runGroupId: runGroup.id,
      runType: "plan",
      status: "pending",
    })

    workspaceData.push({ ws, preview, pendingRunId: pendingRun.id, stateKey, wsTag })
  }

  // Emit a single event after all pending runs are created
  // The preview:update from upsertPreview triggers updatePreviewIds,
  // this run:update ensures the snapshot includes the new runs
  if (workspaceData.length > 0) {
    const first = workspaceData[0]
    events.emitRunUpdate(first.pendingRunId, first.preview.id)
  }

  // Track which workspaces have failed (to skip downstream dependents)
  const failedWorkspaces = new Set<string>()

  // Build a set of dependencies for each workspace for quick lookup
  const workspaceDeps = new Map<string, Set<string>>()
  for (const [source, target] of dependencyGraph.edges) {
    if (!workspaceDeps.has(source)) {
      workspaceDeps.set(source, new Set())
    }
    workspaceDeps.get(source)!.add(target)
  }

  // Execute plan + apply for each workspace in topological order
  // This ensures upstream workspaces complete before downstream ones start
  for (const { ws, preview, pendingRunId, stateKey, wsTag } of workspaceData) {
    // Check if any upstream dependency failed - if so, skip this workspace
    const deps = workspaceDeps.get(ws.path) ?? new Set()
    const failedDeps = [...deps].filter((dep) => failedWorkspaces.has(dep))

    if (failedDeps.length > 0) {
      logger.warn("Skipping workspace due to failed upstream dependency", {
        workspace: ws.path,
        failedDependencies: failedDeps,
      })

      // Mark plan as skipped
      await updateRunStatus(pendingRunId, preview.id, "skipped", {
        errorMessage: `Skipped: upstream dependency failed (${failedDeps.join(", ")})`,
      })
      await updatePreviewStatus(preview.id, "failed")
      failedWorkspaces.add(ws.path)
      continue
    }

    await withSpan("workspace.preview", async (wsSpan) => {
      const wsAttrs = { ...attrs, "yaffle.workspace_path": ws.path, "yaffle.state_key": stateKey }
      wsSpan.setAttributes(wsAttrs)

      // TFC backend: ensure workspace exists and generate run token
      let tfcWorkspaceId: string | undefined
      let tfcWorkspaceName: string | undefined
      let tfcOrganization: string | undefined
      let tfcToken: string | undefined

      if (usingTfcBackend) {
        const tfcWorkspace = await ensurePreviewWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: ctx.repo,
          prNumber: ctx.prNumber,
          workspacePath: ws.path,
          branch: ctx.branch,
        })
        tfcWorkspaceId = tfcWorkspace.id
        tfcWorkspaceName = tfcWorkspace.name
        tfcOrganization = org.slug
        tfcToken = await generateRunToken(preview.id, tfcWorkspace.id, org.id)

        logger.info("TFC workspace ready", {
          ...wsAttrs,
          tfcWorkspaceId: tfcWorkspace.id,
          tfcWorkspaceName,
        })
      }

      const variables = interpolateVariables(ws.variables, varCtx)

      // Plan
      logger.info("planning", wsAttrs)
      await updatePreviewStatus(preview.id, "planning")
      await comment.update(ws.path, { phase: "planning" })

      const planResult = await executeRun({
        ctx,
        preview,
        runner,
        command: "plan",
        stateKey,
        workspacePath: ws.path,
        variables,
        installationToken,
        wsTag,
        createCheckRun: ws.require_approval ?? false,
        existingRunId: pendingRunId,
        runGroupId: runGroup.id,
        tfcWorkspaceId,
        tfcWorkspaceName,
        tfcOrganization,
        tfcToken,
      })

      const planCheckRun = makeCheckRunRef(ctx, planResult.checkRunId)

      if (!planResult.success) {
        await comment.update(ws.path, {
          phase: "plan_failed",
          errorMessage: planResult.errorMessage,
          planCheckRun,
        })
        failedWorkspaces.add(ws.path)
        return
      }

      // Check if apply is needed
      const hasChanges = planResult.planSummary !== "no changes"

      if (!ws.auto_apply || !hasChanges) {
        // No apply needed - either auto_apply disabled or no changes
        await updatePreviewStatus(preview.id, "ready")

        // Create a skipped apply run if no changes (so UI shows A:- instead of A:~)
        if (!hasChanges) {
          const skippedApply = await createTfRun({
            previewId: preview.id,
            runGroupId: runGroup.id,
            runType: "apply",
            status: "skipped",
          })
          events.emitRunUpdate(skippedApply.id, preview.id)
        }

        await comment.update(ws.path, {
          phase: "plan_success",
          planSummary: planResult.planSummary,
          planCheckRun,
        })
        return
      }

      // Apply immediately after plan (DAG execution model)
      logger.info("auto-applying preview", wsAttrs)
      await updatePreviewStatus(preview.id, "applying")
      await comment.update(ws.path, {
        phase: "applying",
        planSummary: planResult.planSummary,
        planCheckRun,
      })

      const applyResult = await executeRun({
        ctx,
        preview,
        runner,
        command: "apply",
        stateKey,
        workspacePath: ws.path,
        variables,
        installationToken,
        wsTag,
        runGroupId: runGroup.id,
        tfcWorkspaceId,
        tfcWorkspaceName,
        tfcOrganization,
        tfcToken,
      })

      const applyCheckRun = makeCheckRunRef(ctx, applyResult.checkRunId)

      if (applyResult.success) {
        await updatePreviewStatus(preview.id, "ready")
        await comment.update(ws.path, {
          phase: "ready",
          planSummary: planResult.planSummary,
          outputs: applyResult.outputs,
          planCheckRun,
          applyCheckRun,
        })

        // Execute apply callbacks (webhooks, github_dispatch)
        if (ws.on_apply && applyResult.outputs) {
          await executeApplyCallbacks(ws.on_apply, {
            owner: ctx.owner,
            repo: ctx.repo,
            prNumber: ctx.prNumber,
            branch: ctx.branch,
            headSha: ctx.headSha,
            workspacePath: ws.path,
            previewId: preview.id,
            outputs: applyResult.outputs,
          }, ctx.installationId)
        }
      } else {
        await comment.update(ws.path, {
          phase: "apply_failed",
          planSummary: planResult.planSummary,
          errorMessage: applyResult.errorMessage,
          planCheckRun,
          applyCheckRun,
        })
        failedWorkspaces.add(ws.path)
      }
    })
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

async function handlePushEvent(
  ctx: PushContext,
  runner: Runner,
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
  const varCtx = pushVariableContext({
    branch: ctx.branch,
    sha: ctx.headSha,
    owner: ctx.owner,
    repo: ctx.repo,
  })
  const usingTfcBackend = useTfcBackend()

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

  // First pass: upsert all previews and create pending runs upfront
  const workspaceData: Array<{
    ws: typeof config.workspaces[0]
    preview: { id: string }
    pendingRunId: string
    stateKey: string
    wsTag: string
    variables: Record<string, string>
  }> = []

  // Iterate in execution order (topological)
  for (const wsPath of executionOrder) {
    const ws = workspaceByPath.get(wsPath)
    if (!ws) continue // Skip if not in config
    const stateKey = buildStateKey(statePrefix, ws.path)
    const wsTag = `${tag}:${ws.path}`
    const variables = interpolateVariables(ws.variables, varCtx)

    // Upsert preview
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
    })

    // Create pending run record upfront
    const pendingRun = await createTfRun({
      previewId: preview.id,
      runGroupId: runGroup.id,
      runType: "plan",
      status: "pending",
    })

    workspaceData.push({ ws, preview, pendingRunId: pendingRun.id, stateKey, wsTag, variables })
  }

  // Emit a single event after all pending runs are created
  if (workspaceData.length > 0) {
    const first = workspaceData[0]
    events.emitRunUpdate(first.pendingRunId, first.preview.id)
  }

  // Track which workspaces have failed (to skip downstream dependents)
  const failedWorkspaces = new Set<string>()

  // Build a set of dependencies for each workspace for quick lookup
  const workspaceDeps = new Map<string, Set<string>>()
  for (const [source, target] of dependencyGraph.edges) {
    if (!workspaceDeps.has(source)) {
      workspaceDeps.set(source, new Set())
    }
    workspaceDeps.get(source)!.add(target)
  }

  // Execute plan + apply for each workspace in topological order
  // This ensures upstream workspaces complete before downstream ones start
  for (const { ws, preview, pendingRunId, stateKey, wsTag, variables } of workspaceData) {
    // Check if any upstream dependency failed - if so, skip this workspace
    const deps = workspaceDeps.get(ws.path) ?? new Set()
    const failedDeps = [...deps].filter((dep) => failedWorkspaces.has(dep))

    if (failedDeps.length > 0) {
      logger.warn("Skipping workspace due to failed upstream dependency", {
        workspace: ws.path,
        failedDependencies: failedDeps,
      })

      // Mark plan as skipped
      await updateRunStatus(pendingRunId, preview.id, "skipped", {
        errorMessage: `Skipped: upstream dependency failed (${failedDeps.join(", ")})`,
      })
      await updatePreviewStatus(preview.id, "failed")
      failedWorkspaces.add(ws.path)
      continue
    }

    await withSpan("workspace.production", async (wsSpan) => {
      const wsAttrs = { ...attrs, "yaffle.workspace_path": ws.path, "yaffle.state_key": stateKey }
      wsSpan.setAttributes(wsAttrs)

      // TFC backend: ensure production workspace exists and generate run token
      let tfcWorkspaceId: string | undefined
      let tfcWorkspaceName: string | undefined
      let tfcOrganization: string | undefined
      let tfcToken: string | undefined

      if (usingTfcBackend) {
        const tfcWorkspace = await ensureProductionWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: ctx.repo,
          branch: ctx.branch,
          workspacePath: ws.path,
        })
        tfcWorkspaceId = tfcWorkspace.id
        tfcWorkspaceName = tfcWorkspace.name
        tfcOrganization = org.slug
        tfcToken = await generateRunToken(preview.id, tfcWorkspace.id, org.id)

        logger.info("TFC production workspace ready", {
          ...wsAttrs,
          tfcWorkspaceId: tfcWorkspace.id,
          tfcWorkspaceName,
        })
      }

      // Plan
      logger.info("planning production", wsAttrs)
      await updatePreviewStatus(preview.id, "planning")

      const planResult = await executeRun({
        ctx,
        preview,
        runner,
        command: "plan",
        stateKey,
        workspacePath: ws.path,
        variables,
        installationToken,
        wsTag,
        createCheckRun: true, // Create check run for production pushes
        existingRunId: pendingRunId,
        runGroupId: runGroup.id,
        tfcWorkspaceId,
        tfcWorkspaceName,
        tfcOrganization,
        tfcToken,
      })

      if (!planResult.success) {
        failedWorkspaces.add(ws.path)
        return
      }

      // Check if there are changes to apply
      const hasChanges = planResult.planSummary !== "no changes"

      if (!hasChanges) {
        // No changes - mark as ready (infrastructure matches desired state)
        await updatePreviewStatus(preview.id, "ready")

        // Create a skipped apply run (so UI shows A:- instead of A:~)
        const skippedApply = await createTfRun({
          previewId: preview.id,
          runGroupId: runGroup.id,
          runType: "apply",
          status: "skipped",
        })
        events.emitRunUpdate(skippedApply.id, preview.id)

        if (planResult.checkRunId && ctx.installationId) {
          await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, planResult.checkRunId, {
            status: "completed",
            conclusion: "success",
            title: "No changes",
            summary: "Infrastructure is up to date.",
          })
        }
        return
      }

      if (ws.require_approval) {
        await updatePreviewStatus(preview.id, "awaiting_approval")
        if (planResult.checkRunId && ctx.installationId) {
          await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, planResult.checkRunId, {
            status: "completed",
            conclusion: "action_required",
            title: "Awaiting approval",
            summary: "Approval required before production apply.",
          })
        }
        // Note: require_approval workspaces don't block downstream
        // because approval/apply happens asynchronously
        return
      }

      // Apply immediately after plan (DAG execution model)
      logger.info("applying production", wsAttrs)
      await updatePreviewStatus(preview.id, "applying")

      // Update the plan's check run to show apply is starting
      if (planResult.checkRunId && ctx.installationId) {
        await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, planResult.checkRunId, {
          status: "in_progress",
          title: "Applying changes",
          summary: `Plan: ${planResult.planSummary ?? "complete"}\n\nApplying...`,
        }).catch((err) => logger.warn("failed to update check run for apply", {
          ...wsAttrs,
          error: err instanceof Error ? err.message : String(err),
        }))
      }

      const applyResult = await executeRun({
        ctx,
        preview,
        runner,
        command: "apply",
        stateKey,
        workspacePath: ws.path,
        variables,
        installationToken,
        wsTag,
        checkRunId: planResult.checkRunId, // Reuse plan's check run
        runGroupId: runGroup.id,
        tfcWorkspaceId,
        tfcWorkspaceName,
        tfcOrganization,
        tfcToken,
      })

      if (applyResult.success) {
        await updatePreviewStatus(preview.id, "ready")

        // Execute apply callbacks (webhooks, github_dispatch)
        if (ws.on_apply && applyResult.outputs) {
          await executeApplyCallbacks(ws.on_apply, {
            owner: ctx.owner,
            repo: ctx.repo,
            prNumber: 0, // Production
            branch: ctx.branch,
            headSha: ctx.headSha,
            workspacePath: ws.path,
            previewId: preview.id,
            outputs: applyResult.outputs,
          }, ctx.installationId)
        }
      } else {
        await updatePreviewStatus(preview.id, "failed")
        failedWorkspaces.add(ws.path)
      }
    })
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
  variables: Record<string, string>
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
 */
function makeCheckRunRef(
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
