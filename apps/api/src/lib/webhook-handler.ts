import type {
  PullRequestContext,
  PushContext,
  TerraformResult,
  WebhookContext,
} from "@yaffle/shared"

import {
  type WorkspaceConfig,
  type YaffleConfig,
  ConfigError,
  interpolateVariables,
  loadConfig,
  parseYaml,
  prVariableContext,
  pushVariableContext,
  validateConfig,
} from "./config.ts"
import { ensureOrg } from "../db/queries/organizations.ts"
import { findPreview, updatePreviewStatus, upsertPreview } from "../db/queries/previews.ts"
import { createTfRun, updateRunStatus } from "../db/queries/tf-runs.ts"
import {
  createCheckRun,
  fetchFileContent,
  getInstallationToken,
  updateCheckRun,
} from "./github.ts"
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
  if (ctx.kind === "pull_request") {
    await handlePullRequestEvent(ctx, runner, configLoader)
  } else {
    await handlePushEvent(ctx, runner, configLoader)
  }
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
  console.log(`handling PR event: ${tag} action=${ctx.action} sha=${ctx.headSha}`)

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
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
  const installationToken = await acquireToken(ctx)

  // Load config
  let config: YaffleConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`failed to load config for ${tag}:`, msg)
    await surfaceConfigError(ctx, msg)
    return
  }

  const wsPaths = config.workspaces.map((ws) => ws.path).join(", ")
  console.log(`[${tag}] config loaded: ${config.workspaces.length} workspace(s) [${wsPaths}]`)

  const statePrefix = previewStatePrefix(ctx.prNumber)
  const varCtx = prVariableContext({
    prNumber: ctx.prNumber,
    branch: ctx.branch,
    sha: ctx.headSha,
    owner: ctx.owner,
    repo: ctx.repo,
  })

  for (const ws of config.workspaces) {
    const stateKey = buildStateKey(statePrefix, ws.path)
    const wsTag = `${tag}:${ws.path}`

    // Upsert preview
    const preview = await upsertPreview({
      orgId: org.id,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      workspacePath: ws.path,
      branch: ctx.branch,
      headSha: ctx.headSha,
      stateKey,
      mode: "terraform",
    })

    const variables = interpolateVariables(ws.variables, varCtx)

    // Plan
    console.log(`[${wsTag}] planning`)
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

    if (!planResult.success) continue

    // Apply if auto_apply
    if (ws.auto_apply) {
      console.log(`[${wsTag}] auto-applying preview`)
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
    } else {
      await updatePreviewStatus(preview.id, "ready")
    }
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
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
  const installationToken = await acquireToken(ctx)

  // Load config to know which workspaces to destroy
  let config: YaffleConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`failed to load config for ${tag}:`, msg)
    await surfaceConfigError(ctx, msg)
    return
  }

  const wsPaths = config.workspaces.map((ws) => ws.path).join(", ")
  console.log(`[${tag}] config loaded: ${config.workspaces.length} workspace(s) [${wsPaths}]`)

  const statePrefix = previewStatePrefix(ctx.prNumber)

  for (const ws of config.workspaces) {
    const stateKey = buildStateKey(statePrefix, ws.path)
    const wsTag = `${tag}:${ws.path}`

    const preview = await findPreview(org.id, ctx.repo, ctx.prNumber, ws.path)
    if (!preview) {
      console.warn(`[${wsTag}] no preview found, nothing to destroy`)
      continue
    }

    console.log(`[${wsTag}] destroying preview`)
    await updatePreviewStatus(preview.id, "destroying")

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
      console.log(`[${wsTag}] preview destroyed`)
    }
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
  console.log(`handling push event: ${tag} sha=${ctx.headSha}`)

  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
  const installationToken = await acquireToken(ctx)

  // Load config -- no PR to annotate on push events, just log
  let config: YaffleConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`failed to load config for ${tag}:`, msg)
    return
  }

  const wsPaths = config.workspaces.map((ws) => ws.path).join(", ")
  console.log(`[${tag}] config loaded: ${config.workspaces.length} workspace(s) [${wsPaths}]`)

  // Determine default branch
  const defaultBranch = config.default_branch ?? ctx.defaultBranch
  if (ctx.branch !== defaultBranch) {
    console.log(`[${tag}] ignoring push to non-default branch (default: ${defaultBranch})`)
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
    if (!ws.auto_apply_on_merge) {
      console.log(`[${tag}:${ws.path}] auto_apply_on_merge disabled, skipping`)
      continue
    }

    const stateKey = buildStateKey(statePrefix, ws.path)
    const wsTag = `${tag}:${ws.path}`
    const variables = interpolateVariables(ws.variables, varCtx)

    // For production, we create a preview record to track the run
    // Using prNumber=0 as a sentinel for production runs
    const preview = await upsertPreview({
      orgId: org.id,
      repo: ctx.repo,
      prNumber: 0,
      workspacePath: ws.path,
      branch: ctx.branch,
      headSha: ctx.headSha,
      stateKey,
      mode: "terraform",
    })

    // Plan
    console.log(`[${wsTag}] planning production`)
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

    if (!planResult.success) continue

    // Apply
    console.log(`[${wsTag}] applying production`)
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
  }
}

// ---------------------------------------------------------------------------
// Shared execution logic
// ---------------------------------------------------------------------------

/**
 * Execute a single terraform run, creating DB records and updating
 * GitHub check runs.
 */
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
}): Promise<TerraformResult> {
  const { ctx, preview, runner, wsTag } = opts

  // Create run record
  const run = await createTfRun({
    previewId: preview.id,
    runType: opts.command,
    status: "pending",
  })

  // Create check run (PR events only, with installation)
  let checkRunId: number | undefined
  if (ctx.installationId && ctx.kind === "pull_request") {
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
      console.warn(`[${wsTag}] failed to create check run:`, err)
    }
  }

  await updateRunStatus(run.id, "running", {
    checkRunId,
    startedAt: new Date(),
  })

  // Execute
  let result: TerraformResult
  try {
    result = await runner.run({
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      command: opts.command,
      workspacePath: opts.workspacePath,
      stateKey: opts.stateKey,
      variables: opts.variables,
      installationToken: opts.installationToken,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${wsTag}] ${opts.command} threw:`, msg)

    result = {
      success: false,
      command: opts.command,
      output: "",
      errorMessage: msg,
      durationMs: 0,
    }
  }

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
  }

  console.log(
    `[${wsTag}] ${opts.command}: success=${result.success} duration=${result.durationMs}ms`,
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
    }).catch((err) => console.warn(`[${wsTag}] failed to update check run:`, err))
  }

  return result
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
    console.warn(`failed to create config error check run:`, err)
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
    console.warn("failed to get installation token:", err)
    return undefined
  }
}
