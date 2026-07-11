import { randomUUID } from "node:crypto"

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
} from "./config-toml.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { findOrgForRepo } from "../db/queries/repo-mappings.ts"
import {
  createPrincipal,
  ensurePrincipalRepoBinding,
  findPrincipalRepoBindingByNamespaceAndFingerprint,
} from "../db/queries/principals.ts"
import {
  findDeploymentById,
  findDeploymentsByEnvironment,
  updateDeploymentStatus,
  recordDeploymentApproval,
  resetSkippedDownstreams,
} from "../db/queries/workspace-deployments.ts"
import { createIacJob, cancelJobsForPreview, findPendingJobsForPreview } from "../db/queries/iac-jobs.ts"
import { findLatestRun } from "../db/queries/tf-runs.ts"
import {
  createRunGroup,
  type RunGroupTrigger,
} from "../db/queries/run-groups.ts"
import { events } from "./events.ts"
import {
  fetchFileContent,
  getInstallationToken,
} from "./github.ts"
import {
  createPendingRunGroupCheck,
  surfaceConfigErrorCheck,
} from "./run-group-checks.ts"
import {
  type CheckRunRef,
  checkRunUrl,
} from "./pr-comment.ts"
import { LocalRunner } from "./local-runner.ts"
import { type Mutex, KeyedMutex } from "./mutex.ts"
import { DbLeaseMutex } from "./db-lease.ts"
import {
  type Runner,
} from "./runner.ts"

import {
  beginWorkspaceArchive,
  getWorkspacesToArchive,
} from "./workspace-service.ts"
import { buildWorkspaceVariablesByPath } from "./workspace-variables.ts"
import { useTfcBackend } from "./tfc-backend.ts"
import {
  getConfigLoadErrorCounter,
  logger,
  withSpan,
} from "./telemetry.ts"
import { createScanJob } from "../db/queries/scan-jobs.ts"
import { generateScanJobToken } from "./job-token.ts"
import { getScheduler } from "./scheduler.ts"
import type { WorkspaceVariablesByPath } from "./workspace-variables.ts"

/** Default runner for production use. Override via createHandler() for tests. */
const defaultRunner: Runner = new LocalRunner()

/**
 * Per-preview mutex. Ensures that concurrent webhook events for the same
 * preview (owner/repo/pr) are processed sequentially. Different previews
 * still run concurrently.
 *
 * Uses lease-based locking (pgbouncer-safe). Falls back to in-memory
 * KeyedMutex in dev/test when DATABASE_URL is not set.
 */
function createMutex(): Mutex {
  const dbUrl = process.env.DATABASE_URL
  if (dbUrl) {
    return new DbLeaseMutex(`webhook-${randomUUID().slice(0, 8)}`)
  }
  return new KeyedMutex()
}

export const previewMutex: Mutex = createMutex()

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
type ScanDispatcher = (
  ctx: WebhookContext,
  orgId: string,
  orgSlug: string,
  runGroupId: string,
  workspacePaths: string[],
  workspaceVariables: WorkspaceVariablesByPath,
  installationToken?: string,
) => Promise<void>

interface ConfigSystemErrorLine {
  lineNumber: number
  text: string
  highlight: boolean
}

interface ConfigSystemError {
  kind: "config"
  title: string
  summary: string
  filePath: string
  line: number | null
  column: number | null
  excerpt: ConfigSystemErrorLine[]
}

/**
 * Also uploads the workspace to S3 cache for later use by runners.
 *
 * @param ctx - Webhook context with repo info
 * @param orgSlug - Organization slug for S3 key
 * @param orgId - Organization ID for resource tagging
 * @param workspacePaths - List of workspace paths from config
 * @param installationToken - GitHub token for cloning
 * @returns Dependency graph, execution order, and workspace S3 key
 */
/**
 * Dispatch a scan job to a scanner worker.
 *
 * Creates a scan_jobs row, generates a token, and spawns the scanner.
 * The scanner will clone the repo, read config, scan dependencies,
 * and call POST /api/scanner/complete with the result.
 *
 * The webhook handler returns immediately after dispatching.
 */
async function dispatchScan(
  ctx: WebhookContext,
  orgId: string,
  orgSlug: string,
  runGroupId: string,
  workspacePaths: string[],
  workspaceVariables: WorkspaceVariablesByPath,
  installationToken?: string,
): Promise<void> {
  const repoUrl = `https://github.com/${ctx.owner}/${ctx.repo}.git`

  const scanJob = await createScanJob({
    runGroupId,
    orgId,
    repoUrl,
    ref: ctx.kind === "pull_request" ? `refs/heads/${(ctx as any).branch}` : (ctx as any).ref,
    headSha: ctx.headSha,
    installationToken,
    orgSlug,
    workspacePaths,
    workspaceVariables,
  })

  const scanToken = await generateScanJobToken(scanJob.id, orgId)

  // Mark run group as scanning so the UI shows progress instead of "no runs"
  const { updateRunGroupStatus } = await import("../db/queries/run-groups.ts")
  await updateRunGroupStatus(runGroupId, "scanning")

  // Use Lambda if configured (fast ~1s cold start), fall back to ECS scanner
  const lambdaFunction = process.env.YAFFLE_SCANNER_LAMBDA_FUNCTION
  if (lambdaFunction) {
    const { LambdaScannerSpawner } = await import("./lambda-scanner-spawner.ts")
    const lambdaSpawner = new LambdaScannerSpawner({
      functionName: lambdaFunction,
      region: process.env.AWS_REGION ?? "us-east-1",
      apiUrl: process.env.YAFFLE_RUNNER_API_URL!,
    })
    await lambdaSpawner.spawnScanner(scanJob.id, scanToken)
  } else {
    const scheduler = await getScheduler()
    await scheduler.spawner.spawnScanner(scanJob.id, scanToken)
  }

  logger.info("Scan job dispatched", {
    "scan_job.id": scanJob.id,
    "run_group.id": runGroupId,
    "yaffle.head_sha": ctx.headSha.slice(0, 7),
  })
}

/**
 * Create a handler with an injected runner and optional overrides.
 * Used by tests to avoid real git clone + tofu invocations.
 */
export function createHandler(
  runner: Runner,
  opts?: { mutex?: Mutex; configLoader?: ConfigLoader; scanDispatcher?: ScanDispatcher },
): {
  handleWebhookEvent: (ctx: WebhookContext) => Promise<void>
} {
  const m = opts?.mutex ?? new KeyedMutex()
  const loader = opts?.configLoader ?? fetchConfig
  const scanDispatcher = opts?.scanDispatcher ?? dispatchScan
  return {
    handleWebhookEvent: (ctx: WebhookContext) =>
      m.run(mutexKey(ctx), () => handleEvent(ctx, runner, loader, scanDispatcher)),
  }
}

/**
 * Handle a webhook event using the default runner.
 * Serialized per-preview via the global mutex.
 */
export async function handleWebhookEvent(ctx: WebhookContext): Promise<void> {
  return previewMutex.run(mutexKey(ctx), () =>
    handleEvent(ctx, defaultRunner, fetchConfig, dispatchScan),
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

    // Manual apply is allowed both before the auto-apply countdown is paused
    // and after it has been explicitly paused for approval.
    if (preview.status !== "awaiting_apply" && preview.status !== "awaiting_approval") {
      throw new Error(`preview is in ${preview.status} state, expected awaiting_apply or awaiting_approval`)
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
  const raw = await fetchRawConfig(ctx)

  if (!raw) {
    throw new ConfigError(
      "No yaffle.toml found. Yaffle requires a config file. See https://yaffle.dev/docs/config",
    )
  }

  return parseYaffleToml(raw)
}

async function fetchRawConfig(ctx: WebhookContext): Promise<string | null> {
  if (!ctx.installationId) {
    throw new ConfigError(
      "Cannot fetch config without a GitHub App installation",
    )
  }

  return (await fetchFileContent(
    ctx.installationId,
    ctx.owner,
    ctx.repo,
    "yaffle.toml",
    ctx.headSha,
  )) ?? null

}

function inferEnvironmentIdentity(ctx: WebhookContext): {
  environmentKind: "named" | "transient"
  environmentName: string
  prNumber: number | null
  ref: string
  trigger: RunGroupTrigger
} {
  if (ctx.kind === "pull_request") {
    return {
      environmentKind: "transient",
      environmentName: buildPrEnvironmentName(ctx.prNumber),
      prNumber: ctx.prNumber,
      ref: `refs/heads/${ctx.branch}`,
      trigger: ctx.action === "opened" ? "pr_opened" : "pr_sync",
    }
  }

  return {
    environmentKind: "named",
    environmentName: ctx.refName,
    prNumber: null,
    ref: ctx.ref,
    trigger: "push",
  }
}

const WEBHOOK_REPO_FINGERPRINT_PREFIX = "webhook-hosted::"

async function ensureWebhookRunGroupRepoBinding(ctx: WebhookContext) {
  const canonicalRepoNamespace = `${ctx.owner}--${ctx.repo}`
  const localRepoFingerprint = `${WEBHOOK_REPO_FINGERPRINT_PREFIX}${canonicalRepoNamespace}`

  const existing = await findPrincipalRepoBindingByNamespaceAndFingerprint({
    canonicalRepoNamespace,
    localRepoFingerprint,
  })
  if (existing) {
    return existing
  }

  const principal = await createPrincipal({ type: "anonymous_session" })
  return ensurePrincipalRepoBinding({
    principalId: principal.id,
    canonicalRepoNamespace,
    localRepoFingerprint,
  })
}

function extractConfigErrorLocation(raw: string, message: string): { line: number | null; column: number | null } {
  const parseMatch = message.match(/line\s+(\d+),\s*column\s+(\d+)/i)
  if (parseMatch) {
    return {
      line: Number(parseMatch[1]),
      column: Number(parseMatch[2]),
    }
  }

  const issueMatch = message.match(/-\s+([^:]+):/)
  const keyHint = issueMatch?.[1]?.split(".").at(-1)?.trim()
  if (!keyHint) {
    return { line: null, column: null }
  }

  const lines = raw.split(/\r?\n/)
  const lineIndex = lines.findIndex((line) => line.includes(keyHint))
  if (lineIndex === -1) {
    return { line: null, column: null }
  }

  return {
    line: lineIndex + 1,
    column: Math.max(lines[lineIndex].indexOf(keyHint) + 1, 1),
  }
}

function buildConfigErrorExcerpt(
  raw: string,
  line: number | null,
): ConfigSystemErrorLine[] {
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0) {
    return []
  }

  const targetLine = line ?? 1
  const start = Math.max(1, targetLine - 3)
  const end = Math.min(lines.length, targetLine + 3)

  const excerpt: ConfigSystemErrorLine[] = []
  for (let current = start; current <= end; current += 1) {
    excerpt.push({
      lineNumber: current,
      text: lines[current - 1] ?? "",
      highlight: current === targetLine,
    })
  }

  return excerpt
}

function buildConfigSystemError(raw: string | null, message: string): ConfigSystemError {
  const location = raw ? extractConfigErrorLocation(raw, message) : { line: null, column: null }

  return {
    kind: "config",
    title: "Configuration error",
    summary: message,
    filePath: "yaffle.toml",
    line: location.line,
    column: location.column,
    excerpt: raw ? buildConfigErrorExcerpt(raw, location.line) : [],
  }
}

async function recordConfigLoadFailure(
  ctx: WebhookContext,
  orgId: string,
  message: string,
): Promise<void> {
  let rawConfig: string | null = null

  try {
    rawConfig = await fetchRawConfig(ctx)
  } catch {
    rawConfig = null
  }

  const detail = buildConfigSystemError(rawConfig, message)
  const identity = inferEnvironmentIdentity(ctx)
  const now = new Date()

  const runGroup = await createRunGroup({
    orgId,
    repoBindingId: (await ensureWebhookRunGroupRepoBinding(ctx)).id,
    repo: ctx.repo,
    environmentKind: identity.environmentKind,
    environmentName: identity.environmentName,
    prNumber: identity.prNumber,
    ref: identity.ref,
    headSha: ctx.headSha,
    selectedWorkspacePaths: [],
    trigger: identity.trigger,
    status: "failed",
    dependencyGraph: {
      workspaces: [],
      edges: [],
      systemError: detail,
    },
    startedAt: now,
    completedAt: now,
  })

  events.emitDeploymentUpdate(
    runGroup.id,
    orgId,
    ctx.repo,
    identity.environmentKind,
    identity.environmentName,
  )
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

async function handleEvent(
  ctx: WebhookContext,
  runner: Runner,
  configLoader: ConfigLoader,
  scanDispatcher: ScanDispatcher,
): Promise<void> {
  const spanName = ctx.kind === "pull_request"
    ? `webhook.pull_request.${ctx.action}`
    : "webhook.push"

  return withSpan(spanName, async (span) => {
    span.setAttributes(contextAttrs(ctx))

    if (ctx.kind === "pull_request") {
      await handlePullRequestEvent(ctx, runner, configLoader, scanDispatcher)
    } else {
      await handlePushEvent(ctx, runner, configLoader, scanDispatcher)
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
  scanDispatcher: ScanDispatcher,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  const attrs = contextAttrs(ctx)
  logger.info(`handling PR event: ${tag} action=${ctx.action} sha=${ctx.headSha}`, attrs)

  switch (ctx.action) {
    case "opened":
    case "reopened":
    case "synchronize":
      await handlePrOpenedOrUpdated(ctx, runner, configLoader, scanDispatcher)
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
  scanDispatcher: ScanDispatcher,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  const attrs = contextAttrs(ctx)

  // Resolve org via repo mapping (fail-closed if unmapped)
  const mapping = await findOrgForRepo(ctx.installationId, ctx.repoGithubId)
  if (!mapping) {
    logger.warn(`ignoring PR event for unmapped repo ${tag}`, attrs)
    return
  }
  const org = await findOrgById(mapping.orgId)
  if (!org) {
    logger.error(`org ${mapping.orgId} not found for mapped repo ${tag}`, attrs)
    return
  }

  const installationToken = await acquireToken(ctx)

  // Load config
  let config: YaffleTomlConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    await recordConfigLoadFailure(ctx, org.id, msg)
    await surfaceConfigErrorCheck(ctx, msg)
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

  // Get workspaces that apply to the GitHub PR's transient environment
  const environmentName = buildPrEnvironmentName(ctx.prNumber)
  const workspacePaths = getWorkspacesForEnvironment(config, environmentName, true)

  if (workspacePaths.length === 0) {
    logger.info("no workspaces configured for transient environments", attrs)
    return
  }

  logger.info(
    `config loaded: ${workspacePaths.length} workspace(s) for PR`,
    { ...attrs, "yaffle.workspace_count": workspacePaths.length },
  )

  let workspaceVariables: WorkspaceVariablesByPath
  try {
    workspaceVariables = buildWorkspaceVariablesByPath(
      config,
      workspacePaths,
      ctx,
      environmentName,
      "transient",
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to resolve workspace variables for ${tag}: ${msg}`, attrs)
    await recordConfigLoadFailure(ctx, org.id, msg)
    await surfaceConfigErrorCheck(ctx, msg)
    return
  }

  // Create a single run group for this PR event (covers both plan and apply)
  const trigger: RunGroupTrigger = ctx.action === "opened" ? "pr_opened" : "pr_sync"
  const runGroup = await createRunGroup({
    orgId: org.id,
    repoBindingId: (await ensureWebhookRunGroupRepoBinding(ctx)).id,
    repo: ctx.repo,
    environmentKind: "transient",
    environmentName,
    prNumber: ctx.prNumber,
    ref: `refs/heads/${ctx.branch}`,
    headSha: ctx.headSha,
    selectedWorkspacePaths: workspacePaths,
    trigger,
    status: "pending",
  })

  await createPendingRunGroupCheck(ctx, {
    runGroupId: runGroup.id,
    orgSlug: org.slug,
    environmentName,
  })

  // Dispatch scan to scanner worker — the scanner will:
  // 1. Clone the repo
  // 2. Scan .tf files for dependencies and build the DAG
  // 3. Upload workspace to S3 cache
  // 4. Call POST /api/scanner/complete which creates deployments and queues plan jobs
  await scanDispatcher(
    ctx,
    org.id,
    org.slug,
    runGroup.id,
    workspacePaths,
    workspaceVariables,
    installationToken,
  )
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

  // Resolve org via repo mapping (fail-closed if unmapped)
  const mapping = await findOrgForRepo(ctx.installationId, ctx.repoGithubId)
  if (!mapping) {
    logger.warn(`ignoring PR closed event for unmapped repo ${tag}`, attrs)
    return
  }
  const org = await findOrgById(mapping.orgId)
  if (!org) {
    logger.error(`org ${mapping.orgId} not found for mapped repo ${tag}`, attrs)
    return
  }

  // Load config to know which workspaces to destroy
  let config: YaffleTomlConfig
  try {
    const installationToken = await acquireToken(ctx)
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    await recordConfigLoadFailure(ctx, org.id, msg)
    await surfaceConfigErrorCheck(ctx, msg)
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
  scanDispatcher: ScanDispatcher,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}@${ctx.ref}`
  const attrs = contextAttrs(ctx)
  logger.info(`handling push event: ${tag} sha=${ctx.headSha}`, attrs)

  // Resolve org via repo mapping (fail-closed if unmapped)
  const mapping = await findOrgForRepo(ctx.installationId, ctx.repoGithubId)
  if (!mapping) {
    logger.warn(`ignoring push event for unmapped repo ${tag}`, attrs)
    return
  }
  const org = await findOrgById(mapping.orgId)
  if (!org) {
    logger.error(`org ${mapping.orgId} not found for mapped repo ${tag}`, attrs)
    return
  }

  const installationToken = await acquireToken(ctx)

  // Load config -- no PR to annotate on push events, just log
  let config: YaffleTomlConfig
  try {
    config = await configLoader(ctx, installationToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to load config for ${tag}: ${msg}`, attrs)
    getConfigLoadErrorCounter().add(1, { owner: ctx.owner, repo: ctx.repo })
    await recordConfigLoadFailure(ctx, org.id, msg)
    await surfaceConfigErrorCheck(ctx, msg)
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

  logger.info(
    `config loaded: ${workspacePaths.length} workspace(s) for ${environmentName}`,
    { ...attrs, "yaffle.workspace_count": workspacePaths.length, environmentName },
  )

  let workspaceVariables: WorkspaceVariablesByPath
  try {
    workspaceVariables = buildWorkspaceVariablesByPath(
      config,
      workspacePaths,
      ctx,
      environmentName,
      "named",
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`failed to resolve workspace variables for ${tag}: ${msg}`, attrs)
    await recordConfigLoadFailure(ctx, org.id, msg)
    await surfaceConfigErrorCheck(ctx, msg)
    return
  }

  // Create a single run group for this push event (covers both plan and apply)
  // Push events to the default branch are "named" environments (e.g., "main", "production")
  const runGroup = await createRunGroup({
    orgId: org.id,
    repoBindingId: (await ensureWebhookRunGroupRepoBinding(ctx)).id,
    repo: ctx.repo,
    environmentKind: "named",
    environmentName,
    prNumber: null, // null for branch/env runs
    ref: ctx.ref,
    headSha: ctx.headSha,
    selectedWorkspacePaths: workspacePaths,
    trigger: "push",
    status: "pending",
  })

  await createPendingRunGroupCheck(ctx, {
    runGroupId: runGroup.id,
    orgSlug: org.slug,
    environmentName,
  })

  // Dispatch scan to scanner worker — the scanner will:
  // 1. Clone the repo
  // 2. Scan .tf files for dependencies and build the DAG
  // 3. Upload workspace to S3 cache
  // 4. Call POST /api/scanner/complete which creates deployments and queues plan jobs
  await scanDispatcher(
    ctx,
    org.id,
    org.slug,
    runGroup.id,
    workspacePaths,
    workspaceVariables,
    installationToken,
  )
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
