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
import { ensureOrg, findOrgById } from "../db/queries/organizations.ts"
import { findPreview, findPreviewById, updatePreviewStatus, upsertPreview } from "../db/queries/previews.ts"
import { appendRunLog, createTfRun, findLatestRun, updateRunStatus } from "../db/queries/tf-runs.ts"
import {
  createCheckRun,
  fetchFileContent,
  getInstallationToken,
  updateCheckRun,
} from "./github.ts"
import {
  type CheckRunRef,
  type CommentManager,
  checkRunUrl,
  createCommentManager,
} from "./pr-comment.ts"
import { LocalRunner } from "./local-runner.ts"
import { KeyedMutex } from "./mutex.ts"
import {
  type RunOpts,
  type Runner,
  buildStateKey,
  previewStatePrefix,
  productionStatePrefix,
} from "./runner.ts"
import { removeState } from "./state.ts"
import {
  type Span,
  SpanStatusCode,
  getConfigLoadErrorCounter,
  getRunDurationHistogram,
  getRunResultCounter,
  logger,
  tracer,
  withSpan,
} from "./telemetry.ts"

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
  approverLogin: string
  githubUserId: number
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
      !approvers.map((a) => a.toLowerCase()).includes(opts.approverLogin.toLowerCase())
    ) {
      throw new Error("approver not authorized")
    }

    const org = await findOrgById(preview.orgId)
    if (!org) {
      throw new Error("organization not found")
    }

    const ctx: PushContext = {
      kind: "push",
      installationId: preview.installationId,
      ownerGithubId: org.githubId,
      owner: org.login,
      repo: preview.repo,
      headSha: preview.headSha,
      branch: preview.branch,
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

    const planRun = await findLatestRun(preview.id, "plan")
    if (planRun?.checkRunId) {
      await updateCheckRun(preview.installationId, ctx.owner, ctx.repo, planRun.checkRunId, {
        status: "in_progress",
        title: "Applying after approval",
        summary: `Approved by @${opts.approverLogin}`,
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
    })

    if (applyResult.success) {
      await updatePreviewStatus(preview.id, "ready")
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
 * Fetch config from the repo via the GitHub Contents API.
 */
async function fetchConfig(ctx: WebhookContext, token?: string): Promise<YaffleConfig> {
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
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
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

  for (const ws of config.workspaces) {
    await withSpan("workspace.preview", async (wsSpan) => {
      const stateKey = buildStateKey(statePrefix, ws.path)
      const wsTag = `${tag}:${ws.path}`
      const wsAttrs = { ...attrs, "yaffle.workspace_path": ws.path, "yaffle.state_key": stateKey }
      wsSpan.setAttributes(wsAttrs)

      // Upsert preview
      const preview = await upsertPreview({
        orgId: org.id,
        installationId: ctx.installationId,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        workspacePath: ws.path,
        branch: ctx.branch,
        headSha: ctx.headSha,
        authorLogin: ctx.authorLogin,
        stateKey,
        mode: "terraform",
        requireApproval: false,
        approvers: null,
      })

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
      })

      const planCheckRun = makeCheckRunRef(ctx, planResult.checkRunId)

      if (!planResult.success) {
        await comment.update(ws.path, {
          phase: "plan_failed",
          errorMessage: planResult.errorMessage,
          planCheckRun,
        })
        return
      }

      // Apply if auto_apply
      if (ws.auto_apply) {
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
        } else {
          await comment.update(ws.path, {
            phase: "apply_failed",
            planSummary: planResult.planSummary,
            errorMessage: applyResult.errorMessage,
            planCheckRun,
            applyCheckRun,
          })
        }
      } else {
        await updatePreviewStatus(preview.id, "ready")
        await comment.update(ws.path, {
          phase: "plan_success",
          planSummary: planResult.planSummary,
          planCheckRun,
        })
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
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
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
  const comment = createCommentManager(ctx)

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
        variables: {},
        installationToken,
        wsTag,
      })

      if (destroyResult.success) {
        await removeState(ctx.owner, ctx.repo, stateKey)
        await updatePreviewStatus(preview.id, "destroyed")
        await comment.update(ws.path, { phase: "destroyed" })
        logger.info("preview destroyed", wsAttrs)
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

  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
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

  const statePrefix = productionStatePrefix(ctx.branch)
  const varCtx = pushVariableContext({
    branch: ctx.branch,
    sha: ctx.headSha,
    owner: ctx.owner,
    repo: ctx.repo,
  })

  for (const ws of config.workspaces) {
    if (!ws.auto_apply_on_merge && !ws.require_approval) {
      logger.info("auto_apply_on_merge disabled, skipping", {
        ...attrs,
        "yaffle.workspace_path": ws.path,
      })
      continue
    }

    await withSpan("workspace.production", async (wsSpan) => {
      const stateKey = buildStateKey(statePrefix, ws.path)
      const wsTag = `${tag}:${ws.path}`
      const variables = interpolateVariables(ws.variables, varCtx)
      const wsAttrs = { ...attrs, "yaffle.workspace_path": ws.path, "yaffle.state_key": stateKey }
      wsSpan.setAttributes(wsAttrs)

      // For production, we create a preview record to track the run
      // Using prNumber=0 as a sentinel for production runs
      const preview = await upsertPreview({
        orgId: org.id,
        installationId: ctx.installationId,
        repo: ctx.repo,
        prNumber: 0,
        workspacePath: ws.path,
        branch: ctx.branch,
        headSha: ctx.headSha,
        stateKey,
        mode: "terraform",
        requireApproval: ws.require_approval ?? false,
        approvers: ws.approvers ?? null,
      })

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
      })

      if (!planResult.success) return

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
        return
      }

      // Apply
      logger.info("applying production", wsAttrs)
      await updatePreviewStatus(preview.id, "applying")

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
      })

      if (applyResult.success) {
        await updatePreviewStatus(preview.id, "ready")
      }
    })
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
}): Promise<RunResult> {
  return withSpan(`run.${opts.command}`, async (span) => {
    const { ctx, preview, runner, wsTag } = opts
    const runAttrs = {
      "yaffle.command": opts.command,
      "yaffle.workspace_path": opts.workspacePath,
      "yaffle.state_key": opts.stateKey,
      "yaffle.owner": ctx.owner,
      "yaffle.repo": ctx.repo,
    }
    span.setAttributes(runAttrs)

    // Create run record
    const run = await createTfRun({
      previewId: preview.id,
      runType: opts.command,
      status: "pending",
    })

    // Create check run (PR events only, with installation)
    let checkRunId: number | undefined
    if (ctx.installationId && (ctx.kind === "pull_request" || opts.createCheckRun)) {
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

    await updateRunStatus(run.id, "running", {
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
        await appendRunLog(run.id, chunk)
      } catch (err) {
        logger.warn("failed to append run logs", {
          ...runAttrs,
          "error": err instanceof Error ? err.message : String(err),
        })
      }
    }
    try {
      flushInterval = setInterval(() => {
        if (!flushing) {
          flushing = flushLogs().finally(() => {
            flushing = null
          })
        }
      }, 1000)

      result = await runner.run({
        owner: ctx.owner,
        repo: ctx.repo,
        headSha: ctx.headSha,
        command: opts.command,
        workspacePath: opts.workspacePath,
        stateKey: opts.stateKey,
        variables: opts.variables,
        installationToken: opts.installationToken,
        onOutput: (chunk, source) => {
          const entry = source === "stderr" ? `[stderr] ${chunk}` : chunk
          logBuffer += entry
          if (logBuffer.length > 4096 && !flushing) {
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
      await updateRunStatus(run.id, "success", {
        completedAt: new Date(),
        planSummary: result.planSummary,
        planJson: result.planJson,
        outputs: result.outputs,
      })
    } else {
      await updateRunStatus(run.id, "failed", {
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
