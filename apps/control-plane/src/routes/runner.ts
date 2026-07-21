/**
 * Runner API Routes
 *
 * These endpoints are used by runner workers to claim jobs, send heartbeats,
 * and report completion. They use job tokens (JWTs) for authentication.
 *
 * Key design principles:
 * - Workers claim jobs atomically (queued -> running)
 * - Workers send heartbeats while executing
 * - Workers report completion with results
 * - All operations are scoped to a single job via job token
 */

import { Hono } from "hono"
import { z } from "zod"

import {
  generateJobToken,
  verifyJobToken,
  verifyWarmRunnerToken,
  type JobTokenPayload,
  type WarmRunnerTokenPayload,
} from "../lib/job-token.ts"
import { getRunnerFirstOutputDurationHistogram, logger, tracer } from "../lib/telemetry.ts"
import {
  claimJobForRunner,
  findQueuedJobsForWarmRunner,
  heartbeatJob,
  failJobFromRunner,
  getJobWithContext,
  settleJobAndRunFromRunner,
} from "../db/queries/iac-jobs.ts"
import {
  getWarmRunnerSession,
  heartbeatWarmRunner,
  markWarmRunnerClaimedJob,
  registerWarmRunner,
} from "../db/queries/warm-runners.ts"
import {
  deploymentBelongsToRunGroup,
  updateDeploymentStatus,
} from "../db/queries/workspace-deployments.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { findLatestScanJobByRunGroup, type ScanJobResult } from "../db/queries/scan-jobs.ts"
import {
  createTfRun,
  getRunLogState,
  findRunById,
  findLatestSuccessfulRun,
} from "../db/queries/tf-runs.ts"
import {
  insertResourceSpanFromRunner,
  completeResourceSpanFromRunner,
  closeOrphanedSpans,
} from "../db/queries/resource-spans.ts"
import {
  buildWorkspaceName,
  findWorkspaceById,
  findWorkspaceByName,
  unlockWorkspace,
} from "../db/queries/workspaces.ts"
import { events } from "../lib/events.ts"
import { type EnvironmentKind } from "../lib/config-toml.ts"
import { useTfcBackend } from "../lib/tfc-backend.ts"
import {
  completeWorkspaceArchive,
  ensureTransientWorkspace,
  ensureNamedWorkspace,
} from "../lib/workspace-service.ts"
import {
  generateRunToken,
  getMergeImpactRunTokenScopes,
  getRunTokenScopes,
} from "../lib/run-token.ts"
import { createWorkspaceCache } from "../lib/workspace-cache.ts"
import { getRunnerCredentialHosts, getRunnerReachableTfcHost } from "../lib/tfc-host.ts"
import { cascadeFailure, notifyDestroyComplete } from "../lib/deployment-side-effects.ts"
import { resolveExecutionCredentialsForDeployment } from "../lib/execution-credentials.ts"
import { validateAutomaticIsolationExecutionContext } from "../lib/automatic-isolation-execution-context.ts"
import { publishHostedOutputModuleForRunGroupBinding } from "../lib/hosted-output-modules.ts"
import {
  executeHostedLifecycleForDeployment,
  reconcileHostedDeploymentState,
} from "../lib/hosted-lifecycle.ts"
import { getConfiguredSchedulerConcurrencyLimits } from "../lib/scheduler.ts"
import { isWarmRunnerWorkspaceExcluded } from "../lib/warm-runner.ts"
import { syncPrCommentForRunGroup } from "../lib/pr-comment-sync.ts"
import {
  OutputSelectionError,
  redactSensitiveOutputValues,
  selectTerraformOutputs,
} from "../lib/output-selection.ts"
import {
  buildExecutionVariables,
  buildMergeImpactVariables,
  ExecutionContextAssociationError,
  findExecutionSnapshotWorkspace,
} from "../lib/execution-snapshot.ts"
import { applyDecisionMatchesExecution, isApplyDecision } from "../lib/execution-mutation.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerAuthContext {
  jobToken: JobTokenPayload
}

interface WarmRunnerAuthContext {
  runnerToken: WarmRunnerTokenPayload
}

type JobContext = Awaited<ReturnType<typeof getJobWithContext>>

function hasHostedExecutionContext(jobContext: JobContext): boolean {
  return Boolean(
    jobContext?.deployment &&
    jobContext.runGroup?.executionSnapshot &&
    jobContext.runGroup.workspaceS3Key,
  )
}

function jobTokenMatchesContext(
  token: JobTokenPayload,
  jobContext: NonNullable<JobContext>,
): boolean {
  const matches =
    token.job_id === jobContext.id &&
    token.deployment_id === jobContext.deployment.id &&
    token.org_id === jobContext.deployment.orgId
  if (!matches) {
    logger.warn("runner.capability.denied", {
      "job.id": jobContext.id,
      "deployment.id": jobContext.deployment.id,
      "org.id": jobContext.deployment.orgId,
      reason: "job_context_mismatch",
    })
  }
  return matches
}

function logRunnerCapabilityDenial(
  token: JobTokenPayload,
  reason: string,
  requestedJobId?: string,
): void {
  logger.warn("runner.capability.denied", {
    "job.id": requestedJobId ?? token.job_id,
    "deployment.id": token.deployment_id,
    "org.id": token.org_id,
    reason,
  })
}

async function runMatchesJob(runId: string, jobContext: NonNullable<JobContext>): Promise<boolean> {
  if (jobContext.status !== "running") {
    logger.warn("runner.capability.denied", {
      "job.id": jobContext.id,
      "run.id": runId,
      "deployment.id": jobContext.deployment.id,
      "org.id": jobContext.deployment.orgId,
      reason: "job_not_running",
    })
    return false
  }
  const run = await findRunById(runId)
  const matches = Boolean(
    run &&
    run.jobId === jobContext.id &&
    run.deploymentId === jobContext.deployment.id &&
    run.runGroupId === jobContext.runGroup?.id &&
    run.runType === jobContext.jobType &&
    run.planPurpose === jobContext.planPurpose &&
    run.status === "running",
  )
  if (!matches) {
    logger.warn("runner.capability.denied", {
      "job.id": jobContext.id,
      "run.id": runId,
      "deployment.id": jobContext.deployment.id,
      "org.id": jobContext.deployment.orgId,
      reason: "run_context_mismatch_or_inactive",
    })
  }
  return matches
}

type RunnerVariables = {
  runnerAuth: RunnerAuthContext
}

type WarmRunnerVariables = {
  warmRunnerAuth: WarmRunnerAuthContext
}

const runnerJobRoute = new Hono<{ Variables: RunnerVariables }>()
const warmRunnerRoute = new Hono<{ Variables: WarmRunnerVariables }>()
export const runnerRoute = new Hono()
const firstOutputSeenRuns = new Set<string>()

const DEFAULT_WARM_RUNNER_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_WARM_RUNNER_POLL_INTERVAL_MS = 1_000
const DEFAULT_WARM_RUNNER_IDLE_SHUTDOWN_MS = 120_000
const DEFAULT_WARM_RUNNER_STALE_AFTER_MS = 30_000

type ClaimResponseDeployment = NonNullable<
  Awaited<ReturnType<typeof getJobWithContext>>
>["deployment"]

async function releaseWorkspaceLockForDeployment(
  deployment: {
    orgId: string
    repo: string
    environmentName: string
    ref: string
    workspacePath: string
    id: string
  },
  runId: string,
  archive: boolean = false,
): Promise<void> {
  const workspaceName = buildWorkspaceName(
    deployment.repo,
    deployment.environmentName,
    deployment.ref,
    deployment.workspacePath,
  )

  const workspace = await findWorkspaceByName(deployment.orgId, workspaceName)
  if (!workspace) {
    return
  }

  if (archive) {
    let archived = await completeWorkspaceArchive(workspace.id)
    if (!archived && workspace.lockedBy === `run:${runId}`) {
      await unlockWorkspace(workspace.id, `run:${runId}`)
      archived = await completeWorkspaceArchive(workspace.id)
    }
    if (!archived) {
      logger.warn("runner.workspace_archive_deferred", {
        "deployment.id": deployment.id,
        "run.id": runId,
        "workspace.id": workspace.id,
        "workspace.name": workspace.name,
        "workspace.locked_by": workspace.lockedBy ?? "unknown",
      })
      return
    }
    logger.info("runner.workspace_archived", {
      "deployment.id": deployment.id,
      "workspace.id": workspace.id,
      "workspace.name": workspace.name,
    })
    return
  }

  if (!workspace.locked) {
    return
  }

  const unlocked = await unlockWorkspace(workspace.id, `run:${runId}`)
  if (!unlocked) {
    logger.warn("runner.workspace_unlock_rejected", {
      "deployment.id": deployment.id,
      "run.id": runId,
      "workspace.id": workspace.id,
      "workspace.name": workspace.name,
      "workspace.locked_by": workspace.lockedBy ?? "unknown",
    })
    return
  }
  logger.info("runner.workspace_unlocked", {
    "deployment.id": deployment.id,
    "run.id": runId,
    "workspace.id": workspace.id,
    "workspace.name": workspace.name,
    "workspace.locked_by": workspace.lockedBy ?? "unknown",
  })
}

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }
  return authHeader.slice(7)
}

function parsePlanSummaryCounts(
  summary: string,
): { add: number; change: number; destroy: number } | null {
  const canonical = summary.match(/^\s*\+(\d+)\s*,\s*~(\d+)\s*,\s*-(\d+)\s*$/)
  if (canonical) {
    return {
      add: Number(canonical[1]),
      change: Number(canonical[2]),
      destroy: Number(canonical[3]),
    }
  }

  const sparseMatches = [...summary.matchAll(/([+~-])(\d+)/g)]
  if (sparseMatches.length === 0) {
    return null
  }

  let add = 0
  let change = 0
  let destroy = 0

  for (const [, prefix, value] of sparseMatches) {
    if (prefix === "+") add = Number(value)
    if (prefix === "~") change = Number(value)
    if (prefix === "-") destroy = Number(value)
  }

  return { add, change, destroy }
}

function deriveHasChangesFromSummary(summary: string | undefined): boolean | null {
  if (!summary) {
    return null
  }
  if (summary === "no changes") {
    return false
  }
  const counts = parsePlanSummaryCounts(summary)
  if (!counts) {
    return null
  }
  return counts.add > 0 || counts.change > 0 || counts.destroy > 0
}

function sanitizePlanSummary(summary: unknown): string | undefined {
  if (summary === "no changes") {
    return summary
  }
  if (typeof summary !== "string") {
    return undefined
  }
  const counts = parsePlanSummaryCounts(summary)
  return counts ? `+${counts.add}, ~${counts.change}, -${counts.destroy}` : undefined
}

function getWarmRunnerSettings(): {
  heartbeatIntervalMs: number
  pollIntervalMs: number
  idleShutdownMs: number
  staleAfterMs: number
} {
  return {
    heartbeatIntervalMs: Number.parseInt(
      process.env.YAFFLE_WARM_RUNNER_HEARTBEAT_INTERVAL_MS ??
        String(DEFAULT_WARM_RUNNER_HEARTBEAT_INTERVAL_MS),
      10,
    ),
    pollIntervalMs: Number.parseInt(
      process.env.YAFFLE_WARM_RUNNER_POLL_INTERVAL_MS ??
        String(DEFAULT_WARM_RUNNER_POLL_INTERVAL_MS),
      10,
    ),
    idleShutdownMs: Number.parseInt(
      process.env.YAFFLE_WARM_RUNNER_IDLE_SHUTDOWN_MS ??
        String(DEFAULT_WARM_RUNNER_IDLE_SHUTDOWN_MS),
      10,
    ),
    staleAfterMs: Number.parseInt(
      process.env.YAFFLE_WARM_RUNNER_STALE_AFTER_MS ?? String(DEFAULT_WARM_RUNNER_STALE_AFTER_MS),
      10,
    ),
  }
}

async function createClaimResponse(
  job: {
    id: string
    jobType: "plan" | "apply" | "destroy"
    deploymentId: string
    queuedAt: Date
    startedAt: Date | null
    planPurpose: string
    targetWorkspaceId: string | null
    targetStateVersionId: string | null
  },
  issueJobToken: boolean,
): Promise<{
  claimed: true
  job: {
    id: string
    jobType: "plan" | "apply" | "destroy"
    deploymentId: string
    queuedAt: Date
    startedAt: Date | null
  }
  runId: string
  deployment: ClaimResponseDeployment
  jobToken?: string
}> {
  const jobContext = await getJobWithContext(job.id)

  if (!jobContext?.deployment || !hasHostedExecutionContext(jobContext)) {
    logger.error("runner.claim.missing_context", { jobId: job.id })
    throw new ExecutionContextAssociationError("Job has no valid hosted execution context")
  }

  const { deployment } = jobContext
  if (job.jobType === "apply") {
    const executionSnapshot = jobContext.runGroup?.executionSnapshot
    const workspace = executionSnapshot?.workspaces.find(
      (candidate) => candidate.path === deployment.workspacePath,
    )
    if (
      !workspace ||
      !executionSnapshot ||
      !applyDecisionMatchesExecution({
        decision: jobContext.applyDecision,
        runGroupId: jobContext.runGroup!.id,
        planRunId: isApplyDecision(jobContext.applyDecision)
          ? jobContext.applyDecision.planRunId
          : "",
        workspacePath: deployment.workspacePath,
        environmentKind: deployment.environmentKind,
        configurationDigest: executionSnapshot.configuration.digest,
        approval: workspace.approval,
      })
    ) {
      await failJobFromRunner(
        {
          jobId: job.id,
          deploymentId: deployment.id,
          runGroupId: jobContext.runGroup!.id,
        },
        "Apply job has no valid authorization decision",
      )
      throw new ExecutionContextAssociationError("Apply job has no valid authorization decision")
    }
  }

  const statusMap: Record<string, "planning" | "applying" | "destroying"> = {
    plan: "planning",
    apply: "applying",
    destroy: "destroying",
  }
  const deploymentStatus = job.planPurpose === "environment" ? statusMap[job.jobType] : undefined
  if (
    deploymentStatus &&
    !(await updateDeploymentStatus(deployment.id, deploymentStatus, jobContext.runGroup!.id))
  ) {
    await failJobFromRunner(
      {
        jobId: job.id,
        deploymentId: deployment.id,
        runGroupId: jobContext.runGroup!.id,
      },
      "Deployment was rebound before runner claim completed",
    )
    throw new Error("Deployment was rebound before runner claim completed")
  }

  const tfRun = await createTfRun({
    jobId: job.id,
    deploymentId: deployment.id,
    runGroupId: jobContext.runGroup?.id ?? undefined,
    runType: job.jobType,
    planPurpose: job.planPurpose,
    targetWorkspaceId: job.targetWorkspaceId,
    targetStateVersionId: job.targetStateVersionId,
    status: "running",
    startedAt: new Date(),
  })
  events.emitRunUpdate(tfRun.id, deployment.id)
  if (jobContext.runGroup?.id) {
    void syncPrCommentForRunGroup(jobContext.runGroup.id)
  }

  events.emitDeploymentUpdate(
    deployment.id,
    deployment.orgId,
    deployment.repo,
    deployment.environmentKind as EnvironmentKind,
    deployment.environmentName,
  )

  const response: {
    claimed: true
    job: {
      id: string
      jobType: "plan" | "apply" | "destroy"
      deploymentId: string
      queuedAt: Date
      startedAt: Date | null
    }
    runId: string
    deployment: typeof deployment
    jobToken?: string
  } = {
    claimed: true,
    job: {
      id: job.id,
      jobType: job.jobType,
      deploymentId: job.deploymentId,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
    },
    runId: tfRun.id,
    deployment,
  }

  if (issueJobToken) {
    response.jobToken = await generateJobToken(job.id, deployment.id, deployment.orgId)
  }

  return response
}

/**
 * Runner authentication middleware.
 * Verifies job token and sets context.
 */
runnerJobRoute.use("*", async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"))

  if (!token) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Job token required" } }, 401)
  }

  const payload = await verifyJobToken(token)
  if (!payload) {
    logger.warn("runner.capability.denied", { reason: "invalid_or_expired_job_token" })
    return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired job token" } }, 401)
  }

  c.set("runnerAuth", { jobToken: payload } as RunnerAuthContext)
  return next()
})

warmRunnerRoute.use("*", async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"))

  if (!token) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Warm runner token required" } }, 401)
  }

  const payload = await verifyWarmRunnerToken(token)
  if (!payload) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or expired warm runner token" } },
      401,
    )
  }

  c.set("warmRunnerAuth", { runnerToken: payload } as WarmRunnerAuthContext)
  return next()
})

const warmRunnerRegisterSchema = z.object({
  workerId: z.string().min(1),
  maxSlots: z.number().int().min(1).max(4).default(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

warmRunnerRoute.post("/register", async (c) => {
  const auth = c.get("warmRunnerAuth") as WarmRunnerAuthContext
  const body = await c.req.json()
  const parsed = warmRunnerRegisterSchema.safeParse(body)

  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const settings = getWarmRunnerSettings()
  const session = await registerWarmRunner(
    auth.runnerToken.org_id,
    parsed.data.workerId,
    parsed.data.maxSlots,
    parsed.data.metadata,
    settings.staleAfterMs,
  )

  return c.json({
    data: {
      runnerId: session.id,
      orgId: session.orgId,
      maxSlots: session.maxSlots,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      pollIntervalMs: settings.pollIntervalMs,
      idleShutdownMs: settings.idleShutdownMs,
    },
  })
})

const warmRunnerHeartbeatSchema = z.object({
  runnerId: z.string().uuid(),
  workerId: z.string().min(1),
  activeSlots: z.number().int().min(0).max(4).default(0),
})

warmRunnerRoute.post("/heartbeat", async (c) => {
  const auth = c.get("warmRunnerAuth") as WarmRunnerAuthContext
  const body = await c.req.json()
  const parsed = warmRunnerHeartbeatSchema.safeParse(body)

  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const settings = getWarmRunnerSettings()
  const session = await heartbeatWarmRunner(
    parsed.data.runnerId,
    auth.runnerToken.org_id,
    parsed.data.workerId,
    parsed.data.activeSlots,
    settings.staleAfterMs,
  )

  if (!session) {
    return c.json({ error: { code: "NOT_FOUND", message: "Warm runner session not found" } }, 404)
  }

  return c.json({ data: { success: true } })
})

const warmRunnerClaimNextSchema = z.object({
  runnerId: z.string().uuid(),
  workerId: z.string().min(1),
  availableSlots: z.number().int().min(1).max(4).default(1),
})

warmRunnerRoute.post("/claim-next", async (c) => {
  const auth = c.get("warmRunnerAuth") as WarmRunnerAuthContext
  const body = await c.req.json()
  const parsed = warmRunnerClaimNextSchema.safeParse(body)

  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const settings = getWarmRunnerSettings()
  const heartbeat = await heartbeatWarmRunner(
    parsed.data.runnerId,
    auth.runnerToken.org_id,
    parsed.data.workerId,
    0,
    settings.staleAfterMs,
  )

  if (!heartbeat) {
    return c.json({ error: { code: "NOT_FOUND", message: "Warm runner session not found" } }, 404)
  }

  const { maxConcurrentJobs, maxJobsPerRunGroup } = getConfiguredSchedulerConcurrencyLimits()
  const currentSession = await getWarmRunnerSession(
    parsed.data.runnerId,
    auth.runnerToken.org_id,
    parsed.data.workerId,
  )

  if (!currentSession) {
    return c.json({ error: { code: "NOT_FOUND", message: "Warm runner session not found" } }, 404)
  }

  const availableSlots = Math.max(1, Math.min(parsed.data.availableSlots, currentSession.maxSlots))

  const candidates = await findQueuedJobsForWarmRunner(
    auth.runnerToken.org_id,
    {
      maxTotal: maxConcurrentJobs,
      maxPerRunGroup: maxJobsPerRunGroup,
    },
    availableSlots,
  )

  for (const candidate of candidates) {
    const jobContext = await getJobWithContext(candidate.id)
    if (
      !jobContext?.deployment ||
      jobContext.deployment.orgId !== auth.runnerToken.org_id ||
      !hasHostedExecutionContext(jobContext)
    ) {
      continue
    }

    if (isWarmRunnerWorkspaceExcluded(jobContext.deployment.workspacePath)) {
      logger.info("warm_runner.workspace_excluded", {
        "runner.id": parsed.data.runnerId,
        "worker.id": parsed.data.workerId,
        "job.id": candidate.id,
        "org.id": auth.runnerToken.org_id,
        "workspace.path": jobContext.deployment.workspacePath,
      })
      continue
    }

    const resolution = await resolveExecutionCredentialsForDeployment(jobContext.deployment)
    if (!resolution.ok) {
      logger.info("warm_runner.job_waiting_for_connections", {
        "runner.id": parsed.data.runnerId,
        "worker.id": parsed.data.workerId,
        "job.id": candidate.id,
        "org.id": auth.runnerToken.org_id,
        missingProviders: resolution.missingProviders,
        conflictProviders: resolution.conflictProviders,
        degradationKind: resolution.degradation?.kind,
        degradationErrorKind: resolution.degradation?.errorKind,
        degradationMessage: resolution.degradation?.message,
      })
      continue
    }

    const result = await claimJobForRunner(
      {
        jobId: candidate.id,
        deploymentId: jobContext.deployment.id,
        runGroupId: jobContext.runGroup!.id,
      },
      parsed.data.workerId,
    )
    if (!result.claimed || !result.job) {
      continue
    }

    await markWarmRunnerClaimedJob(
      parsed.data.runnerId,
      auth.runnerToken.org_id,
      parsed.data.workerId,
      Math.min(currentSession.maxSlots, currentSession.activeSlots + 1),
      settings.staleAfterMs,
    )

    const claimResponse = await createClaimResponse(result.job, true)

    logger.info("warm_runner.claimed_next", {
      "runner.id": parsed.data.runnerId,
      "worker.id": parsed.data.workerId,
      "job.id": result.job.id,
      "job.type": result.job.jobType,
      "org.id": auth.runnerToken.org_id,
      availableSlots,
      activeSlots: Math.min(currentSession.maxSlots, currentSession.activeSlots + 1),
      maxSlots: currentSession.maxSlots,
    })

    return c.json({
      data: claimResponse,
    })
  }

  return c.json({
    data: {
      claimed: false,
    },
  })
})

// ---------------------------------------------------------------------------
// POST /api/runner/claim
// ---------------------------------------------------------------------------

const claimBodySchema = z.object({
  jobId: z.string().uuid(),
  workerId: z.string().min(1),
})

/**
 * Claim a job atomically.
 *
 * Transitions job from "queued" to "running".
 * Returns job details if claimed, or 409 if already claimed.
 */
runnerJobRoute.post("/claim", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()

  const parsed = claimBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const { jobId, workerId } = parsed.data

  // Verify job token matches the job being claimed
  if (auth.jobToken.job_id !== jobId) {
    logRunnerCapabilityDenial(auth.jobToken, "job_id_mismatch", jobId)
    logger.warn("runner.claim.token_mismatch", {
      "job.id.token": auth.jobToken.job_id,
      "job.id.requested": jobId,
    })
    return c.json({ error: { code: "FORBIDDEN", message: "Job token does not match job ID" } }, 403)
  }

  const jobContext = await getJobWithContext(jobId)
  if (!jobContext || !jobTokenMatchesContext(auth.jobToken, jobContext)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job context" } },
      403,
    )
  }
  if (!hasHostedExecutionContext(jobContext)) {
    return c.json(
      { error: { code: "EXECUTION_CONTEXT_INVALID", message: "Job execution context is invalid" } },
      409,
    )
  }

  // Attempt atomic claim
  const result = await claimJobForRunner(
    {
      jobId,
      deploymentId: jobContext.deployment.id,
      runGroupId: jobContext.runGroup!.id,
    },
    workerId,
    auth.jobToken.spawn_lease_token,
  )

  if (!result.claimed) {
    // Job was already claimed or doesn't exist
    logger.info("runner.claim.conflict", {
      "job.id": jobId,
      "worker.id": workerId,
    })
    return c.json(
      { error: { code: "CONFLICT", message: "Job already claimed or not in queued state" } },
      409,
    )
  }

  // Note: lifecycle log "job.claimed" is emitted by claimJobForRunner()
  // This is just an API-level acknowledgement

  const claimResponse = await createClaimResponse(result.job!, false)

  return c.json({
    data: claimResponse,
  })
})

// ---------------------------------------------------------------------------
// POST /api/runner/logs
// ---------------------------------------------------------------------------

const logsBodySchema = z.object({
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
  chunk: z.string(),
  source: z.enum(["stdout", "stderr"]).optional(),
})

/**
 * Accept a worker log chunk for liveness telemetry.
 *
 * Chunks are not persisted or streamed because output sensitivity metadata is
 * unavailable until completion. The worker submits the complete log with its
 * outputs, allowing the completion path to redact before persistence.
 */
runnerJobRoute.post("/logs", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()

  const parsed = logsBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const { jobId, runId, source } = parsed.data

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    logRunnerCapabilityDenial(auth.jobToken, "job_id_mismatch", jobId)
    return c.json({ error: { code: "FORBIDDEN", message: "Job token does not match job ID" } }, 403)
  }
  const jobContext = await getJobWithContext(jobId)
  if (
    !jobContext ||
    !jobTokenMatchesContext(auth.jobToken, jobContext) ||
    !hasHostedExecutionContext(jobContext) ||
    !(await runMatchesJob(runId, jobContext))
  ) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Run does not belong to job token" } },
      403,
    )
  }

  let firstOutputState: { runType: string; startedAt: Date | null } | undefined

  if (!firstOutputSeenRuns.has(runId)) {
    const runState = await getRunLogState(runId)
    if (runState) {
      firstOutputSeenRuns.add(runId)
      if (!runState.hasLogOutput) {
        firstOutputState = {
          runType: runState.runType,
          startedAt: runState.startedAt,
        }
      }
    }
  }

  if (firstOutputState?.startedAt) {
    const firstOutputMs = Date.now() - firstOutputState.startedAt.getTime()
    getRunnerFirstOutputDurationHistogram().record(firstOutputMs, {
      dispatch_mode: "burst",
      run_type: firstOutputState.runType,
      source: source ?? "stdout",
    })
    logger.info("runner.first_output", {
      "job.id": jobId,
      "run.id": runId,
      "org.id": auth.jobToken.org_id,
      runType: firstOutputState.runType,
      source: source ?? "stdout",
      "duration.first_output_ms": firstOutputMs,
    })
  }

  return c.json({ data: { success: true } })
})

// ---------------------------------------------------------------------------
// POST /api/runner/spans
// ---------------------------------------------------------------------------

const spanEventSchema = z.object({
  resourceAddress: z.string().min(1),
  resourceType: z.string(),
  action: z.string(),
  event: z.enum(["started", "progress", "complete", "error"]),
  timestamp: z.number(),
  elapsedMs: z.number().optional(),
  message: z.string().optional(),
})

const spansBodySchema = z.object({
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
  events: z.array(spanEventSchema),
})

/**
 * Receive batched resource span events from worker.
 *
 * For "started" events, inserts a new resource_spans row.
 * For "complete"/"error" events, updates the existing row.
 * For "progress" events, no-ops (the frontend uses wall-clock for in-progress bars).
 * Also mirrors spans to Axiom via OTel tracer.
 */
runnerJobRoute.post("/spans", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()

  const parsed = spansBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const { jobId, runId, events: spanEvents } = parsed.data

  if (auth.jobToken.job_id !== jobId) {
    logRunnerCapabilityDenial(auth.jobToken, "job_id_mismatch", jobId)
    return c.json({ error: { code: "FORBIDDEN", message: "Job token does not match job ID" } }, 403)
  }
  const jobContext = await getJobWithContext(jobId)
  if (
    !jobContext ||
    !jobTokenMatchesContext(auth.jobToken, jobContext) ||
    !hasHostedExecutionContext(jobContext) ||
    !(await runMatchesJob(runId, jobContext))
  ) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Run does not belong to job token" } },
      403,
    )
  }

  const capability = {
    runId,
    jobId,
    deploymentId: jobContext.deployment.id,
    runGroupId: jobContext.runGroup!.id,
  }

  for (const event of spanEvents) {
    if (event.event === "started") {
      const inserted = await insertResourceSpanFromRunner(capability, {
        resourceAddress: event.resourceAddress,
        resourceType: event.resourceType,
        action: event.action,
        status: "started",
        startedAt: new Date(event.timestamp),
        source: "log_parse",
      })
      if (!inserted) {
        logRunnerCapabilityDenial(auth.jobToken, "db_capability_predicate_failed", jobId)
        return c.json(
          { error: { code: "FORBIDDEN", message: "Job capability is no longer active" } },
          403,
        )
      }

      // Mirror to Axiom via OTel — start a span (will be ended on complete/error)
      emitResourceOtelSpan(runId, event)
    } else if (event.event === "complete" || event.event === "error") {
      const completed = await completeResourceSpanFromRunner(
        capability,
        event.resourceAddress,
        event.action,
        {
          status: event.event === "complete" ? "complete" : "error",
          completedAt: new Date(event.timestamp),
          durationMs: event.elapsedMs,
          attributes: event.message ? { message: event.message } : undefined,
        },
      )
      if (!completed) {
        logRunnerCapabilityDenial(auth.jobToken, "db_capability_predicate_failed", jobId)
        return c.json(
          { error: { code: "FORBIDDEN", message: "Job capability is no longer active" } },
          403,
        )
      }

      // Mirror completed span to Axiom
      emitResourceOtelSpan(runId, event)
    }
    // "progress" events are ignored for storage — the UI uses timestamps
  }

  // Emit run update to trigger SSE refresh
  events.emitRunUpdate(runId, auth.jobToken.deployment_id)

  return c.json({ data: { success: true } })
})

/**
 * Emit a resource span to Axiom via OTel tracer.
 */
function emitResourceOtelSpan(runId: string, event: z.infer<typeof spanEventSchema>): void {
  try {
    const span = tracer.startSpan(`tofu.resource.${event.action}`, {
      startTime: new Date(event.timestamp),
      attributes: {
        "tofu.resource.address": event.resourceAddress,
        "tofu.resource.type": event.resourceType,
        "tofu.resource.action": event.action,
        "tofu.resource.event": event.event,
        "yaffle.run.id": runId,
      },
    })
    if (event.event === "complete" || event.event === "error") {
      // For complete/error, end the span immediately with the event timestamp
      span.end(new Date(event.timestamp))
    } else {
      // For started events, end immediately (we'll get a complete event later)
      span.end(new Date(event.timestamp))
    }
  } catch {
    // OTel span emission is best-effort
  }
}

// ---------------------------------------------------------------------------
// POST /api/runner/heartbeat
// ---------------------------------------------------------------------------

const heartbeatBodySchema = z.object({
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
})

/**
 * Update job heartbeat.
 *
 * Called periodically by workers to indicate they're still alive.
 * Returns success: false if job was reclaimed or completed.
 */
runnerJobRoute.post("/heartbeat", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()

  const parsed = heartbeatBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const { jobId, runId } = parsed.data

  const jobContext = await getJobWithContext(jobId)
  if (
    !jobContext ||
    !jobTokenMatchesContext(auth.jobToken, jobContext) ||
    !hasHostedExecutionContext(jobContext) ||
    !(await runMatchesJob(runId, jobContext))
  ) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job context" } },
      403,
    )
  }

  const result = await heartbeatJob({
    jobId,
    runId,
    deploymentId: jobContext.deployment.id,
    runGroupId: jobContext.runGroup!.id,
  })

  if (!result.success) {
    // Job is no longer in running state (completed, failed, or reclaimed)
    logger.warn("runner.heartbeat.rejected", {
      "job.id": jobId,
      reason: "job_not_running",
    })
    return c.json({
      data: { success: false, reason: "Job is no longer in running state" },
    })
  }

  return c.json({ data: { success: true } })
})

// ---------------------------------------------------------------------------
// POST /api/runner/complete
// ---------------------------------------------------------------------------

const completeBodySchema = z.object({
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
  status: z.enum(["completed", "failed"]),
  result: z.record(z.unknown()).optional(),
  errorMessage: z.string().optional(),
  logOutput: z.string().optional(),
})

/**
 * Report job completion.
 *
 * Called by workers when they finish executing a job.
 * Triggers downstream effects (status updates, notifications).
 */
runnerJobRoute.post("/complete", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()

  const parsed = completeBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const { jobId, runId, status, result, logOutput } = parsed.data

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    logRunnerCapabilityDenial(auth.jobToken, "job_id_mismatch", jobId)
    return c.json({ error: { code: "FORBIDDEN", message: "Job token does not match job ID" } }, 403)
  }

  let success: boolean
  const jobContext = await getJobWithContext(jobId)
  if (!jobContext?.deployment) {
    return c.json({ error: { code: "NOT_FOUND", message: "Job context not found" } }, 404)
  }
  if (!jobTokenMatchesContext(auth.jobToken, jobContext)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job context" } },
      403,
    )
  }
  if (jobContext.status !== "queued" && jobContext.status !== "running") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job capability is no longer active" } },
      403,
    )
  }
  if (!hasHostedExecutionContext(jobContext)) {
    return c.json(
      { error: { code: "EXECUTION_CONTEXT_INVALID", message: "Job execution context is invalid" } },
      409,
    )
  }
  if (!(await runMatchesJob(runId, jobContext))) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Run does not belong to job token" } },
      403,
    )
  }

  const { deployment } = jobContext
  const executionRunGroupId = jobContext.runGroup?.id ?? null
  const jobType = jobContext.jobType
  const isMergeImpact = jobContext.planPurpose === "merge_impact"
  const capability = {
    jobId,
    runId,
    deploymentId: deployment.id,
    runGroupId: jobContext.runGroup!.id,
  }

  if (status === "completed") {
    const now = new Date()
    const planSummary = sanitizePlanSummary(result?.planSummary)
    const reportedPlanFileS3Key =
      !isMergeImpact && typeof result?.planFileS3Key === "string" ? result.planFileS3Key : undefined
    if (
      reportedPlanFileS3Key &&
      (!reportedPlanFileS3Key.startsWith(`plan-files/${runId}/`) ||
        !reportedPlanFileS3Key.endsWith("/tfplan"))
    ) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Plan artifact does not belong to run" } },
        403,
      )
    }
    const reportedHasChanges = typeof result?.hasChanges === "boolean" ? result.hasChanges : null
    const derivedHasChanges = deriveHasChangesFromSummary(planSummary)
    if (
      reportedHasChanges !== null &&
      derivedHasChanges !== null &&
      reportedHasChanges !== derivedHasChanges
    ) {
      return c.json(
        { error: { code: "PLAN_RESULT_CONFLICT", message: "Plan change signals conflict" } },
        409,
      )
    }
    if (
      !isMergeImpact &&
      jobType === "plan" &&
      reportedHasChanges === null &&
      derivedHasChanges === null
    ) {
      return c.json(
        { error: { code: "PLAN_RESULT_UNKNOWN", message: "Plan change signal is required" } },
        409,
      )
    }
    const hasChanges = reportedHasChanges === true || derivedHasChanges === true
    if (!isMergeImpact && jobType === "plan" && hasChanges) {
      if (!reportedPlanFileS3Key) {
        return c.json(
          { error: { code: "PLAN_ARTIFACT_REQUIRED", message: "Changed plan requires artifact" } },
          409,
        )
      }
      try {
        await createWorkspaceCache().assertPlanFileExists(reportedPlanFileS3Key)
      } catch (error) {
        logger.warn("runner.complete.plan_artifact_unavailable", {
          "job.id": jobId,
          "run.id": runId,
          reason: "artifact_not_found",
          error: error instanceof Error ? error.message : String(error),
        })
        return c.json(
          { error: { code: "PLAN_ARTIFACT_UNAVAILABLE", message: "Plan artifact unavailable" } },
          409,
        )
      }
    }
    const reportedOutputs =
      result?.outputs && typeof result.outputs === "object"
        ? (result.outputs as Record<string, unknown>)
        : null
    let storedOutputs: Record<string, unknown> | null = null
    try {
      storedOutputs = selectTerraformOutputs({
        outputs: reportedOutputs ?? {},
        selection: { kind: "all" },
        sensitive: "redact",
      })
    } catch (error) {
      if (error instanceof OutputSelectionError) {
        const failedAt = new Date()
        const failureMessage = "Runner returned invalid Terraform output metadata"
        const settlement = await settleJobAndRunFromRunner({
          capability,
          jobStatus: "failed",
          jobErrorMessage: failureMessage,
          runStatus: "failed",
          runUpdates: { completedAt: failedAt, errorMessage: failureMessage },
        })
        if (settlement.success) {
          await closeOrphanedSpans(runId, failedAt)
          if (!isMergeImpact) {
            if (await updateDeploymentStatus(deployment.id, "failed", capability.runGroupId)) {
              await cascadeFailure(deployment.id, capability.runGroupId)
            }
            await releaseWorkspaceLockForDeployment(deployment, runId)
          }
        }
        return c.json(
          { error: { code: error.code, message: error.message, outputNames: error.outputNames } },
          422,
        )
      }
      throw error
    }
    const storedResult = {
      success: true,
      command: jobType,
      hasChanges: reportedHasChanges ?? derivedHasChanges ?? undefined,
      planSummary,
      planFileS3Key: reportedPlanFileS3Key,
      outputs: storedOutputs,
    }
    const settlement = await settleJobAndRunFromRunner({
      capability,
      jobStatus: "completed",
      jobResult: storedResult,
      runStatus: "success",
      runUpdates: {
        completedAt: now,
        logOutput: redactSensitiveOutputValues(logOutput, reportedOutputs) ?? undefined,
        planSummary,
        planFileS3Key: reportedPlanFileS3Key,
        outputs: storedOutputs,
      },
    })
    success = settlement.success

    if (success) {
      // Close any orphaned spans (refresh/read ops that don't emit completion lines)
      await closeOrphanedSpans(runId, now)

      const deploymentIsCurrent = await deploymentBelongsToRunGroup(
        deployment.id,
        capability.runGroupId,
      )
      if (!deploymentIsCurrent) {
        logger.warn("runner.complete.side_effects_skipped", {
          "job.id": jobId,
          "run.id": runId,
          deploymentId: deployment.id,
          runGroupId: capability.runGroupId,
          reason: "deployment_rebound",
        })
      } else if (!isMergeImpact && jobType === "plan") {
        if (hasChanges) {
          await updateDeploymentStatus(deployment.id, "awaiting_apply", capability.runGroupId)
        } else {
          try {
            const skippedApply = await createTfRun({
              deploymentId: deployment.id,
              runGroupId: executionRunGroupId ?? undefined,
              runType: "apply",
              status: "skipped",
            })
            events.emitRunUpdate(skippedApply.id, deployment.id)

            const latestApply = await findLatestSuccessfulRun(deployment.id, "apply")
            const latestOutputs =
              latestApply?.outputs && typeof latestApply.outputs === "object"
                ? (latestApply.outputs as Record<string, unknown>)
                : null

            await publishHostedOutputModuleForRunGroupBinding({
              runGroupId: executionRunGroupId,
              deploymentId: deployment.id,
              environmentName: deployment.environmentName,
              workspacePath: deployment.workspacePath,
              outputs: latestOutputs,
            })
            const lifecycle = await executeHostedLifecycleForDeployment({
              runGroupId: executionRunGroupId,
              deployment: {
                id: deployment.id,
                orgId: deployment.orgId,
                repo: deployment.repo,
                environmentKind: deployment.environmentKind,
                environmentName: deployment.environmentName,
                workspacePath: deployment.workspacePath,
                installationId: deployment.installationId,
              },
              outputs: latestOutputs ?? {},
            })
            await reconcileHostedDeploymentState({
              deploymentId: deployment.id,
              workspacePath: deployment.workspacePath,
              lifecycleRunId: lifecycle.runId,
              runGroupId: executionRunGroupId,
            })
          } catch (error) {
            logger.error("runner.complete.noop_lifecycle_failed", {
              "job.id": jobId,
              "run.id": runId,
              deploymentId: deployment.id,
              runGroupId: executionRunGroupId ?? undefined,
              workspacePath: deployment.workspacePath,
              error: error instanceof Error ? error.message : String(error),
            })
            if (
              await updateDeploymentStatus(deployment.id, "system_error", capability.runGroupId)
            ) {
              await cascadeFailure(deployment.id, capability.runGroupId)
            }
          }
        }
      } else if (jobType === "apply") {
        try {
          await publishHostedOutputModuleForRunGroupBinding({
            runGroupId: executionRunGroupId,
            deploymentId: deployment.id,
            environmentName: deployment.environmentName,
            workspacePath: deployment.workspacePath,
            outputs:
              result?.outputs && typeof result.outputs === "object"
                ? (result.outputs as Record<string, unknown>)
                : null,
          })
          const lifecycle = await executeHostedLifecycleForDeployment({
            runGroupId: executionRunGroupId,
            deployment: {
              id: deployment.id,
              orgId: deployment.orgId,
              repo: deployment.repo,
              environmentKind: deployment.environmentKind,
              environmentName: deployment.environmentName,
              workspacePath: deployment.workspacePath,
              installationId: deployment.installationId,
            },
            outputs:
              result?.outputs && typeof result.outputs === "object"
                ? (result.outputs as Record<string, unknown>)
                : {},
          })
          await reconcileHostedDeploymentState({
            deploymentId: deployment.id,
            workspacePath: deployment.workspacePath,
            lifecycleRunId: lifecycle.runId,
            runGroupId: executionRunGroupId,
          })
        } catch (error) {
          logger.error("runner.complete.hosted_output_publish_failed", {
            "job.id": jobId,
            "run.id": runId,
            deploymentId: deployment.id,
            runGroupId: executionRunGroupId ?? undefined,
            workspacePath: deployment.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          })
          if (await updateDeploymentStatus(deployment.id, "system_error", capability.runGroupId)) {
            await cascadeFailure(deployment.id, capability.runGroupId)
          }
        }
      } else if (jobType === "destroy") {
        if (await updateDeploymentStatus(deployment.id, "destroyed", capability.runGroupId)) {
          await notifyDestroyComplete(deployment.id)
        }
      }

      if (!isMergeImpact) {
        await releaseWorkspaceLockForDeployment(deployment, runId, jobType === "destroy")
      }
    }
  } else {
    const failedAt = new Date()
    const failureOutputs =
      result?.outputs && typeof result.outputs === "object"
        ? (result.outputs as Record<string, unknown>)
        : null
    let storedFailureMessage = "Terraform run failed"
    let storedFailureLog: string | undefined
    try {
      storedFailureLog = redactSensitiveOutputValues(logOutput, failureOutputs) ?? undefined
    } catch (error) {
      if (!(error instanceof OutputSelectionError)) {
        throw error
      }
      storedFailureMessage = "Terraform run failed; output metadata was invalid"
    }
    const settlement = await settleJobAndRunFromRunner({
      capability,
      jobStatus: "failed",
      jobErrorMessage: storedFailureMessage,
      runStatus: "failed",
      runUpdates: {
        completedAt: failedAt,
        logOutput: storedFailureLog,
        errorMessage: storedFailureMessage,
      },
    })
    success = settlement.success

    if (success) {
      // Close any orphaned spans
      await closeOrphanedSpans(runId, failedAt)
      if (!isMergeImpact) {
        if (await updateDeploymentStatus(deployment.id, "failed", capability.runGroupId)) {
          await cascadeFailure(deployment.id, capability.runGroupId)
        }
        await releaseWorkspaceLockForDeployment(deployment, runId)
      }
    }
  }

  if (!success) {
    logger.warn("runner.complete.conflict", {
      "job.id": jobId,
      "job.status.requested": status,
      reason: "job_not_running",
    })
    return c.json({ error: { code: "CONFLICT", message: "Job is not in running state" } }, 409)
  }

  // Note: lifecycle log "job.completed" or "job.failed" is emitted by the DB functions
  // This is just an API-level acknowledgement

  // Emit events for real-time UI updates
  // The worker runs in a separate process, so we need to emit from the CP
  events.emitJobUpdate(jobId, auth.jobToken.deployment_id)

  // Also emit deployment update so the DAG UI refreshes
  events.emitDeploymentUpdate(
    deployment.id,
    deployment.orgId,
    deployment.repo,
    deployment.environmentKind as EnvironmentKind,
    deployment.environmentName,
  )

  firstOutputSeenRuns.delete(runId)
  if (executionRunGroupId) {
    void syncPrCommentForRunGroup(executionRunGroupId)
  }

  return c.json({ data: { success: true } })
})

// ---------------------------------------------------------------------------
// GET /api/runner/job/:jobId
// ---------------------------------------------------------------------------

/**
 * Get job details.
 *
 * Returns full job context for execution.
 */
runnerJobRoute.get("/job/:jobId", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const jobId = c.req.param("jobId")

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    logRunnerCapabilityDenial(auth.jobToken, "job_id_mismatch", jobId)
    return c.json({ error: { code: "FORBIDDEN", message: "Job token does not match job ID" } }, 403)
  }

  const jobContext = await getJobWithContext(jobId)
  if (!jobContext) {
    return c.json({ error: { code: "NOT_FOUND", message: "Job not found" } }, 404)
  }
  if (!jobTokenMatchesContext(auth.jobToken, jobContext)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job context" } },
      403,
    )
  }
  if (jobContext.status !== "queued" && jobContext.status !== "running") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job capability is no longer active" } },
      403,
    )
  }
  if (!hasHostedExecutionContext(jobContext)) {
    return c.json(
      { error: { code: "EXECUTION_CONTEXT_INVALID", message: "Job execution context is invalid" } },
      409,
    )
  }

  return c.json({
    data: {
      job: {
        id: jobContext.id,
        jobType: jobContext.jobType,
        status: jobContext.status,
        deploymentId: jobContext.deploymentId,
        queuedAt: jobContext.queuedAt,
        startedAt: jobContext.startedAt,
      },
      deployment: jobContext.deployment,
    },
  })
})

// ---------------------------------------------------------------------------
// POST /api/runner/plan-file-url
// ---------------------------------------------------------------------------

/**
 * Get a presigned URL for uploading the plan file binary after plan completes.
 * The runner uploads the tfplan binary to S3 so apply can use it directly
 * instead of re-planning.
 */
runnerJobRoute.post("/plan-file-url", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()
  const { runId } = body

  if (!runId || typeof runId !== "string") {
    return c.json({ error: { code: "BAD_REQUEST", message: "runId is required" } }, 400)
  }
  const jobContext = await getJobWithContext(auth.jobToken.job_id)
  if (jobContext?.planPurpose === "merge_impact") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Merge-impact plans cannot be persisted for apply" } },
      403,
    )
  }
  if (
    !jobContext ||
    !jobTokenMatchesContext(auth.jobToken, jobContext) ||
    !hasHostedExecutionContext(jobContext) ||
    !(await runMatchesJob(runId, jobContext))
  ) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Run does not belong to job token" } },
      403,
    )
  }

  try {
    const cache = createWorkspaceCache()
    const { uploadUrl, s3Key } = await cache.getPlanFileUploadUrl(runId)

    logger.info("runner.plan_file_url.generated", {
      "job.id": auth.jobToken.job_id,
      "run.id": runId,
      "s3.key": s3Key,
    })

    return c.json({ data: { uploadUrl, s3Key } })
  } catch (err) {
    logger.error("runner.plan_file_url.failed", {
      "job.id": auth.jobToken.job_id,
      "run.id": runId,
      error: err instanceof Error ? err.message : String(err),
    })
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to generate upload URL" } },
      500,
    )
  }
})

// ---------------------------------------------------------------------------
// GET /api/runner/job/:jobId/context
// ---------------------------------------------------------------------------

/**
 * Get execution context for a job.
 *
 * Returns everything the worker needs to execute the job:
 * - Presigned S3 URL for workspace download
 * - Command (plan/apply/destroy)
 * - Workspace path within the tarball
 * - Rendered variables
 * - Backend config (TFC)
 * - TFC token
 * - Plan file URL (for apply jobs, to apply from saved plan)
 */
runnerJobRoute.get("/job/:jobId/context", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const jobId = c.req.param("jobId")
  const requestedRunId = c.req.query("runId")

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    logRunnerCapabilityDenial(auth.jobToken, "job_id_mismatch", jobId)
    return c.json({ error: { code: "FORBIDDEN", message: "Job token does not match job ID" } }, 403)
  }

  const jobContext = await getJobWithContext(jobId)
  if (!jobContext) {
    return c.json({ error: { code: "NOT_FOUND", message: "Job not found" } }, 404)
  }
  if (!jobTokenMatchesContext(auth.jobToken, jobContext)) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job context" } },
      403,
    )
  }
  if (jobContext.status !== "running") {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job capability is no longer active" } },
      403,
    )
  }

  const { deployment, runGroup, ...job } = jobContext

  if (!requestedRunId) {
    return c.json(
      { error: { code: "RUN_ID_REQUIRED", message: "Execution context requires a run ID" } },
      400,
    )
  }

  if (!(await runMatchesJob(requestedRunId, jobContext))) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Run does not belong to job token" } },
      403,
    )
  }

  // Get organization
  const org = await findOrgById(deployment.orgId)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  if (!runGroup?.executionSnapshot) {
    return c.json(
      {
        error: {
          code: "EXECUTION_SNAPSHOT_MISSING",
          message: "Job is not bound to an immutable execution snapshot",
        },
      },
      409,
    )
  }

  const executionSnapshot = runGroup.executionSnapshot
  const workspaceSnapshot = findExecutionSnapshotWorkspace(
    executionSnapshot,
    deployment.workspacePath,
  )
  if (!workspaceSnapshot) {
    return c.json(
      {
        error: {
          code: "WORKSPACE_SNAPSHOT_MISSING",
          message: "Workspace is not present in the job execution snapshot",
        },
      },
      409,
    )
  }
  const isMergeImpact = job.planPurpose === "merge_impact"
  const mergeImpact = executionSnapshot.mergeImpact
  const targetWorkspace =
    isMergeImpact && job.targetWorkspaceId
      ? await findWorkspaceById(job.targetWorkspaceId)
      : undefined
  if (
    isMergeImpact &&
    (job.jobType !== "plan" ||
      !mergeImpact ||
      !job.targetStateVersionId ||
      !targetWorkspace ||
      targetWorkspace.orgId !== deployment.orgId ||
      targetWorkspace.repo !== deployment.repo ||
      targetWorkspace.workspacePath !== deployment.workspacePath ||
      targetWorkspace.environmentKind !== "named" ||
      targetWorkspace.environmentName !== mergeImpact.environmentName ||
      targetWorkspace.ref !== mergeImpact.ref ||
      targetWorkspace.status !== "active" ||
      targetWorkspace.currentStateVersionId !== job.targetStateVersionId)
  ) {
    return c.json(
      {
        error: {
          code: "MERGE_IMPACT_TARGET_STALE",
          message: "Merge-impact target state is unavailable or changed",
        },
      },
      409,
    )
  }

  const scanJob = await findLatestScanJobByRunGroup(runGroup.id)
  const scanResult =
    scanJob?.status === "completed" && scanJob.result && typeof scanJob.result === "object"
      ? (scanJob.result as ScanJobResult)
      : undefined
  const isolationContext = validateAutomaticIsolationExecutionContext({
    orgId: deployment.orgId,
    repositoryId: String(executionSnapshot.source.repositoryId),
    workspacePath: deployment.workspacePath,
    environmentKind: executionSnapshot.environment.kind,
    environmentName: executionSnapshot.environment.name,
    sourceRevision: executionSnapshot.source.commitSha,
    automaticPreviewIsolation: workspaceSnapshot.automaticPreviewIsolation,
    scanResult,
  })
  if (!isolationContext.ok) {
    return c.json(
      {
        error: {
          code: isolationContext.code,
          message: isolationContext.message,
        },
      },
      409,
    )
  }

  let workspaceUrl: string | undefined
  if (runGroup.workspaceS3Key) {
    try {
      const cache = createWorkspaceCache()
      workspaceUrl = await cache.getDownloadUrl(runGroup.workspaceS3Key)
    } catch (err) {
      logger.warn("Failed to generate workspace download URL", {
        jobId,
        s3Key: runGroup.workspaceS3Key,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!workspaceUrl) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Workspace not available - S3 key not found" } },
      404,
    )
  }

  const environmentKind = isMergeImpact ? "named" : executionSnapshot.environment.kind
  const environmentName = isMergeImpact
    ? mergeImpact!.environmentName
    : executionSnapshot.environment.name
  const variables = isMergeImpact
    ? buildMergeImpactVariables(executionSnapshot, deployment.workspacePath)
    : buildExecutionVariables(executionSnapshot, deployment.workspacePath)
  if (!variables) {
    return c.json(
      { error: { code: "WORKSPACE_SNAPSHOT_MISSING", message: "Workspace variables unavailable" } },
      409,
    )
  }

  // TFC backend setup
  let backendConfig:
    | {
        hostname: string
        organization: string
        workspaceName: string
        credentialHosts: string[]
      }
    | undefined
  let tfcToken: string | undefined
  let executionEnv: Record<string, string> = {}

  const credentialResolution = await resolveExecutionCredentialsForDeployment(deployment)
  if (!credentialResolution.ok) {
    const parts: string[] = []
    if (credentialResolution.degradation) {
      parts.push(credentialResolution.degradation.message)
    }
    if (credentialResolution.missingProviders.length > 0) {
      parts.push(`missing connections for: ${credentialResolution.missingProviders.join(", ")}`)
    }
    if (credentialResolution.conflictProviders.length > 0) {
      parts.push(
        `conflicting connections for: ${credentialResolution.conflictProviders.join(", ")}`,
      )
    }

    return c.json(
      {
        error: {
          code: credentialResolution.degradation
            ? "WORKSPACE_METADATA_UNAVAILABLE"
            : "CONNECTIONS_NOT_READY",
          message: parts.join("; "),
        },
      },
      credentialResolution.degradation ? 424 : 409,
    )
  }

  executionEnv = credentialResolution.env

  logger.info("runner.context.execution_env", {
    jobId,
    deploymentId: deployment.id,
    workspacePath: deployment.workspacePath,
    executionEnvVarCount: Object.keys(executionEnv).length,
    executionEnvVarKeys: Object.keys(executionEnv).sort(),
  })

  if (useTfcBackend()) {
    const tfcWorkspace = isMergeImpact
      ? targetWorkspace!
      : environmentKind === "transient"
        ? await ensureTransientWorkspace({
            orgId: org.id,
            orgSlug: org.slug,
            repo: executionSnapshot.source.repository,
            environment: environmentName,
            workspacePath: deployment.workspacePath,
            ref: executionSnapshot.source.ref,
          })
        : await ensureNamedWorkspace({
            orgId: org.id,
            orgSlug: org.slug,
            repo: executionSnapshot.source.repository,
            environment: environmentName,
            ref: executionSnapshot.source.ref,
            workspacePath: deployment.workspacePath,
          })

    backendConfig = {
      hostname: getRunnerReachableTfcHost(),
      organization: org.slug,
      workspaceName: tfcWorkspace.name,
      credentialHosts: getRunnerCredentialHosts(),
    }
    tfcToken = await generateRunToken({
      runId: requestedRunId,
      jobId,
      deploymentId: deployment.id,
      runGroupId: runGroup.id,
      workspaceId: tfcWorkspace.id,
      orgId: org.id,
      scopes: isMergeImpact ? getMergeImpactRunTokenScopes() : getRunTokenScopes(job.jobType),
    })
  }

  // Apply only the saved plan named by the authorized decision.
  let planFileUrl: string | undefined
  if (job.jobType === "apply") {
    try {
      if (!isApplyDecision(job.applyDecision)) {
        return c.json(
          { error: { code: "APPLY_NOT_AUTHORIZED", message: "Apply authorization is invalid" } },
          409,
        )
      }
      const approvedPlan = await findRunById(job.applyDecision.planRunId)
      if (
        !approvedPlan?.planFileS3Key ||
        approvedPlan.deploymentId !== deployment.id ||
        approvedPlan.runGroupId !== runGroup.id ||
        approvedPlan.runType !== "plan" ||
        approvedPlan.status !== "success"
      ) {
        return c.json(
          { error: { code: "PLAN_ARTIFACT_UNAVAILABLE", message: "Saved plan is unavailable" } },
          409,
        )
      }
      const cache = createWorkspaceCache()
      await cache.assertPlanFileExists(approvedPlan.planFileS3Key)
      planFileUrl = await cache.getDownloadUrl(approvedPlan.planFileS3Key)
      logger.info("runner.context.plan_file_url", {
        jobId,
        planRunId: approvedPlan.id,
        s3Key: approvedPlan.planFileS3Key,
      })
    } catch (err) {
      logger.warn("runner.context.plan_file_url_failed", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      return c.json(
        { error: { code: "PLAN_ARTIFACT_UNAVAILABLE", message: "Saved plan is unavailable" } },
        409,
      )
    }
  }

  const finalJobContext = await getJobWithContext(jobId)
  if (
    !finalJobContext ||
    !jobTokenMatchesContext(auth.jobToken, finalJobContext) ||
    !(await runMatchesJob(requestedRunId, finalJobContext))
  ) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job capability is no longer active" } },
      403,
    )
  }

  return c.json({
    data: {
      workspaceUrl,
      command: job.jobType as "plan" | "apply" | "destroy",
      workspacePath: deployment.workspacePath,
      workspaceArtifactSha256: isolationContext.workspaceArtifactSha256,
      automaticIsolationRequired: isMergeImpact
        ? false
        : isolationContext.automaticIsolationRequired,
      automaticIsolationManifest: isMergeImpact
        ? undefined
        : isolationContext.automaticIsolationManifest,
      automaticIsolationCleanupManifest: isMergeImpact
        ? isolationContext.automaticIsolationManifest
        : undefined,
      variables,
      executionEnv,
      backendConfig,
      tfcToken,
      lockState: isMergeImpact ? false : undefined,
      persistPlanFile: isMergeImpact ? false : undefined,
      planFileUrl,
    },
  })
})

runnerRoute.route("/warm", warmRunnerRoute)
runnerRoute.route("/", runnerJobRoute)
