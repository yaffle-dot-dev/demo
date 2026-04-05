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
  completeJobFromRunner,
  failJobFromRunner,
  getJobWithContext,
} from "../db/queries/iac-jobs.ts"
import {
  heartbeatWarmRunner,
  markWarmRunnerClaimedJob,
  registerWarmRunner,
} from "../db/queries/warm-runners.ts"
import { updateDeploymentStatus } from "../db/queries/workspace-deployments.ts"
import { findRunGroupById } from "../db/queries/run-groups.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import {
  createTfRun,
  appendRunLog,
  getRunLogState,
  updateRunStatus,
  findLatestSuccessfulRun,
} from "../db/queries/tf-runs.ts"
import { insertResourceSpan, completeResourceSpan, closeOrphanedSpans } from "../db/queries/resource-spans.ts"
import {
  buildWorkspaceName,
  findWorkspaceByName,
  forceUnlockWorkspace,
} from "../db/queries/workspaces.ts"
import { events } from "../lib/events.ts"
import {
  type EnvironmentKind,
  buildPrEnvironmentName,
  parseYaffleToml,
  type Workspace,
} from "../lib/config-toml.ts"
import { renderVariables, TemplateError, type TemplateContext } from "../lib/templating.ts"
import { fetchFileContent } from "../lib/github.ts"
import { useTfcBackend } from "../lib/tfc-backend.ts"
import { ensurePreviewWorkspace, ensureNamedWorkspace } from "../lib/workspace-service.ts"
import { generateRunToken } from "../lib/run-token.ts"
import { createWorkspaceCache } from "../lib/workspace-cache.ts"
import { getRunnerReachableTfcHost } from "../lib/tfc-host.ts"
import {
  cascadeFailure,
  notifyDestroyComplete,
  notifyDownstreams,
} from "../lib/deployment-side-effects.ts"
import { resolveExecutionCredentialsForDeployment } from "../lib/execution-credentials.ts"
import { getConfiguredSchedulerConcurrencyLimits } from "../lib/scheduler.ts"
import { isWarmRunnerWorkspaceExcluded } from "../lib/warm-runner.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerAuthContext {
  jobToken: JobTokenPayload
}

interface WarmRunnerAuthContext {
  runnerToken: WarmRunnerTokenPayload
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

type ClaimResponseDeployment = NonNullable<Awaited<ReturnType<typeof getJobWithContext>>>["deployment"]

async function releaseWorkspaceLockForDeployment(deployment: {
  orgId: string
  repo: string
  environmentName: string
  ref: string
  workspacePath: string
  id: string
}): Promise<void> {
  const workspaceName = buildWorkspaceName(
    deployment.repo,
    deployment.environmentName,
    deployment.ref,
    deployment.workspacePath,
  )

  const workspace = await findWorkspaceByName(deployment.orgId, workspaceName)
  if (!workspace?.locked) {
    return
  }

  await forceUnlockWorkspace(workspace.id)
  logger.info("runner.workspace_force_unlocked", {
    "deployment.id": deployment.id,
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

function parsePlanSummaryCounts(summary: string): { add: number; change: number; destroy: number } | null {
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

function getWarmRunnerSettings(): {
  heartbeatIntervalMs: number
  pollIntervalMs: number
  idleShutdownMs: number
  staleAfterMs: number
} {
  return {
    heartbeatIntervalMs: Number.parseInt(
      process.env.YAFFLE_WARM_RUNNER_HEARTBEAT_INTERVAL_MS ?? String(DEFAULT_WARM_RUNNER_HEARTBEAT_INTERVAL_MS),
      10,
    ),
    pollIntervalMs: Number.parseInt(
      process.env.YAFFLE_WARM_RUNNER_POLL_INTERVAL_MS ?? String(DEFAULT_WARM_RUNNER_POLL_INTERVAL_MS),
      10,
    ),
    idleShutdownMs: Number.parseInt(
      process.env.YAFFLE_WARM_RUNNER_IDLE_SHUTDOWN_MS ?? String(DEFAULT_WARM_RUNNER_IDLE_SHUTDOWN_MS),
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

  if (!jobContext?.deployment) {
    logger.error("runner.claim.missing_context", { jobId: job.id })
    throw new Error("Job context not found after claim")
  }

  const { deployment } = jobContext

  const tfRun = await createTfRun({
    deploymentId: deployment.id,
    runGroupId: deployment.runGroupId ?? undefined,
    runType: job.jobType,
    status: "running",
    startedAt: new Date(),
  })
  events.emitRunUpdate(tfRun.id, deployment.id)

  const statusMap: Record<string, "planning" | "applying" | "destroying"> = {
    plan: "planning",
    apply: "applying",
    destroy: "destroying",
  }
  const deploymentStatus = statusMap[job.jobType]
  if (deploymentStatus) {
    await updateDeploymentStatus(deployment.id, deploymentStatus)
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
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Job token required" } },
      401,
    )
  }

  const payload = await verifyJobToken(token)
  if (!payload) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or expired job token" } },
      401,
    )
  }

  c.set("runnerAuth", { jobToken: payload } as RunnerAuthContext)
  return next()
})

warmRunnerRoute.use("*", async (c, next) => {
  const token = extractBearerToken(c.req.header("authorization"))

  if (!token) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Warm runner token required" } },
      401,
    )
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
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
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
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
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
    return c.json(
      { error: { code: "NOT_FOUND", message: "Warm runner session not found" } },
      404,
    )
  }

  return c.json({ data: { success: true } })
})

const warmRunnerClaimNextSchema = z.object({
  runnerId: z.string().uuid(),
  workerId: z.string().min(1),
})

warmRunnerRoute.post("/claim-next", async (c) => {
  const auth = c.get("warmRunnerAuth") as WarmRunnerAuthContext
  const body = await c.req.json()
  const parsed = warmRunnerClaimNextSchema.safeParse(body)

  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
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
    return c.json(
      { error: { code: "NOT_FOUND", message: "Warm runner session not found" } },
      404,
    )
  }

  const { maxConcurrentJobs, maxJobsPerRunGroup } = getConfiguredSchedulerConcurrencyLimits()
  const candidates = await findQueuedJobsForWarmRunner(auth.runnerToken.org_id, {
    maxTotal: maxConcurrentJobs,
    maxPerRunGroup: maxJobsPerRunGroup,
  })

  for (const candidate of candidates) {
    const jobContext = await getJobWithContext(candidate.id)
    if (!jobContext?.deployment || jobContext.deployment.orgId !== auth.runnerToken.org_id) {
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
      })
      continue
    }

    const result = await claimJobForRunner(candidate.id, parsed.data.workerId)
    if (!result.claimed || !result.job) {
      continue
    }

    await markWarmRunnerClaimedJob(
      parsed.data.runnerId,
      auth.runnerToken.org_id,
      parsed.data.workerId,
      1,
      settings.staleAfterMs,
    )

    const claimResponse = await createClaimResponse(result.job, true)

    logger.info("warm_runner.claimed_next", {
      "runner.id": parsed.data.runnerId,
      "worker.id": parsed.data.workerId,
      "job.id": result.job.id,
      "job.type": result.job.jobType,
      "org.id": auth.runnerToken.org_id,
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
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
      400,
    )
  }

  const { jobId, workerId } = parsed.data

  // Verify job token matches the job being claimed
  if (auth.jobToken.job_id !== jobId) {
    logger.warn("runner.claim.token_mismatch", {
      "job.id.token": auth.jobToken.job_id,
      "job.id.requested": jobId,
    })
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  // Attempt atomic claim
  const result = await claimJobForRunner(jobId, workerId, auth.jobToken.spawn_lease_token)

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
 * Stream log chunk from worker.
 *
 * Appends log output to the tf_run record and emits SSE event for UI.
 */
runnerJobRoute.post("/logs", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()

  const parsed = logsBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
      400,
    )
  }

  const { jobId, runId, chunk, source } = parsed.data

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  // Format chunk with source prefix if stderr
  const formattedChunk = source === "stderr" ? `[stderr] ${chunk}` : chunk

  let firstOutputState:
    | { runType: string; startedAt: Date | null }
    | undefined

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

  // Append to run logs
  await appendRunLog(runId, auth.jobToken.deployment_id, formattedChunk)

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
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
      400,
    )
  }

  const { jobId, runId, events: spanEvents } = parsed.data

  if (auth.jobToken.job_id !== jobId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  for (const event of spanEvents) {
    if (event.event === "started") {
      await insertResourceSpan({
        runId,
        resourceAddress: event.resourceAddress,
        resourceType: event.resourceType,
        action: event.action,
        status: "started",
        startedAt: new Date(event.timestamp),
        source: "log_parse",
      })

      // Mirror to Axiom via OTel — start a span (will be ended on complete/error)
      emitResourceOtelSpan(runId, event)
    } else if (event.event === "complete" || event.event === "error") {
      await completeResourceSpan(runId, event.resourceAddress, event.action, {
        status: event.event === "complete" ? "complete" : "error",
        completedAt: new Date(event.timestamp),
        durationMs: event.elapsedMs,
        attributes: event.message ? { message: event.message } : undefined,
      })

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
function emitResourceOtelSpan(
  runId: string,
  event: z.infer<typeof spanEventSchema>,
): void {
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
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
      400,
    )
  }

  const { jobId } = parsed.data

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  const result = await heartbeatJob(jobId)

  if (!result.success) {
    // Job is no longer in running state (completed, failed, or reclaimed)
    logger.warn("runner.heartbeat.rejected", {
      "job.id": jobId,
      "reason": "job_not_running",
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
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
      400,
    )
  }

  const { jobId, runId, status, result, errorMessage } = parsed.data

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  let success: boolean
  const jobContext = await getJobWithContext(jobId)
  if (!jobContext?.deployment) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Job context not found" } },
      404,
    )
  }

  const { deployment } = jobContext
  const jobType = jobContext.jobType

  if (status === "completed") {
    const completeResult = await completeJobFromRunner(jobId, result ?? {})
    success = completeResult.success

    if (success) {
      const now = new Date()
      const planSummary = typeof result?.planSummary === "string" ? result.planSummary : undefined
      const planFileS3Key = typeof result?.planFileS3Key === "string" ? result.planFileS3Key : undefined
      await updateRunStatus(runId, deployment.id, "success", {
        completedAt: now,
        planSummary,
        planJson: result?.planJson,
        planFileS3Key,
        outputs: result?.outputs,
      })

      // Close any orphaned spans (refresh/read ops that don't emit completion lines)
      await closeOrphanedSpans(runId, now)

      if (jobType === "plan") {
        const reportedHasChanges = typeof result?.hasChanges === "boolean" ? result.hasChanges : null
        const derivedHasChanges = deriveHasChangesFromSummary(planSummary)
        const hasChanges = reportedHasChanges ?? derivedHasChanges ?? false

        if (reportedHasChanges == null && derivedHasChanges == null) {
          logger.warn("runner.complete.plan_changes_unknown", {
            "job.id": jobId,
            "run.id": runId,
            planSummary: planSummary ?? "missing",
            reason: "missing_deterministic_change_signal",
          })
        }

        if (hasChanges) {
          await updateDeploymentStatus(deployment.id, "awaiting_apply")
        } else {
          await updateDeploymentStatus(deployment.id, "ready")

          const skippedApply = await createTfRun({
            deploymentId: deployment.id,
            runGroupId: deployment.runGroupId ?? undefined,
            runType: "apply",
            status: "skipped",
          })
          events.emitRunUpdate(skippedApply.id, deployment.id)

          await notifyDownstreams(deployment.id, "apply")
        }
      } else if (jobType === "apply") {
        await updateDeploymentStatus(deployment.id, "ready")
        await notifyDownstreams(deployment.id, "apply")
      } else if (jobType === "destroy") {
        await updateDeploymentStatus(deployment.id, "destroyed")
        await notifyDestroyComplete(deployment.id)
      }

      await releaseWorkspaceLockForDeployment(deployment)
    }
  } else {
    const failResult = await failJobFromRunner(jobId, errorMessage ?? "Unknown error")
    success = failResult.success

    if (success) {
      const failedAt = new Date()
      await updateRunStatus(runId, deployment.id, "failed", {
        completedAt: failedAt,
        errorMessage: errorMessage ?? "Unknown error",
      })

      // Close any orphaned spans
      await closeOrphanedSpans(runId, failedAt)
      await updateDeploymentStatus(deployment.id, "failed")
      await cascadeFailure(deployment.id)
      await releaseWorkspaceLockForDeployment(deployment)
    }
  }

  if (!success) {
    logger.warn("runner.complete.conflict", {
      "job.id": jobId,
      "job.status.requested": status,
      "reason": "job_not_running",
    })
    return c.json(
      { error: { code: "CONFLICT", message: "Job is not in running state" } },
      409,
    )
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
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  const jobContext = await getJobWithContext(jobId)
  if (!jobContext) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Job not found" } },
      404,
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
    return c.json(
      { error: { code: "BAD_REQUEST", message: "runId is required" } },
      400,
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

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  const jobContext = await getJobWithContext(jobId)
  if (!jobContext) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Job not found" } },
      404,
    )
  }

  const { deployment, ...job } = jobContext

  // Get organization
  const org = await findOrgById(deployment.orgId)
  if (!org) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Organization not found" } },
      404,
    )
  }

  // Get run group to find workspace S3 key
  let workspaceUrl: string | undefined
  if (deployment.runGroupId) {
    const runGroup = await findRunGroupById(deployment.runGroupId)
    if (runGroup?.workspaceS3Key) {
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
  }

  if (!workspaceUrl) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Workspace not available - S3 key not found" } },
      404,
    )
  }

  // Parse owner/repo
  const repoParts = deployment.repo.split("/")
  const owner = repoParts.length > 1 ? repoParts[0] : org.slug
  const repo = repoParts.length > 1 ? repoParts[1] : deployment.repo

  // Determine environment
  const isPr = deployment.prNumber != null && deployment.prNumber > 0
  const environmentKind = isPr ? "transient" : "named"
  const environmentName = isPr
    ? buildPrEnvironmentName(deployment.prNumber!)
    : deployment.environmentName

  // Build variables - always inject environment and environment_kind
  const variables: Record<string, string | boolean | number> = {
    environment: environmentName,
    environment_kind: environmentKind,
  }

  // Fetch config to get workspace-specific variables
  if (deployment.installationId) {
    try {
      const configRaw = await fetchFileContent(
        deployment.installationId,
        owner,
        repo,
        "yaffle.toml",
        deployment.headSha,
      )
      if (configRaw) {
        const config = parseYaffleToml(configRaw)
        const workspace = config.workspaces.find((ws: Workspace) => ws.path === deployment.workspacePath)

        if (workspace?.variables) {
          const refName = deployment.ref.replace(/^refs\/(heads|tags)\//, "")
          const templateContext: TemplateContext = {
            environment: environmentName,
            environment_kind: environmentKind,
            org: owner,
            repo,
            workspace_path: deployment.workspacePath,
            branch: refName,
            commit_sha: deployment.headSha,
            pr_number: isPr ? deployment.prNumber! : null,
          }

          try {
            const renderedVars = renderVariables(
              workspace.variables,
              templateContext,
              deployment.workspacePath,
            )
            for (const [key, value] of Object.entries(renderedVars)) {
              variables[key] = value
            }
          } catch (err) {
            if (err instanceof TemplateError) {
              return c.json(
                { error: { code: "TEMPLATE_ERROR", message: err.message } },
                400,
              )
            }
            throw err
          }
        }
      }
    } catch (err) {
      logger.warn("Failed to load config for variables", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // TFC backend setup
  let backendConfig: { hostname: string; organization: string; workspaceName: string } | undefined
  let tfcToken: string | undefined
  let executionEnv: Record<string, string> = {}

  const credentialResolution = await resolveExecutionCredentialsForDeployment(deployment)
  if (!credentialResolution.ok) {
    const parts: string[] = []
    if (credentialResolution.missingProviders.length > 0) {
      parts.push(`missing connections for: ${credentialResolution.missingProviders.join(", ")}`)
    }
    if (credentialResolution.conflictProviders.length > 0) {
      parts.push(`conflicting connections for: ${credentialResolution.conflictProviders.join(", ")}`)
    }

    return c.json(
      { error: { code: "CONNECTIONS_NOT_READY", message: parts.join("; ") } },
      409,
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
    const tfcWorkspace = isPr
      ? await ensurePreviewWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: deployment.repo,
          environment: environmentName,
          prNumber: deployment.prNumber!,
          workspacePath: deployment.workspacePath,
          ref: deployment.ref,
        })
      : await ensureNamedWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: deployment.repo,
          environment: environmentName,
          ref: deployment.ref,
          workspacePath: deployment.workspacePath,
        })

    backendConfig = {
      hostname: getRunnerReachableTfcHost(),
      organization: org.slug,
      workspaceName: tfcWorkspace.name,
    }
    tfcToken = await generateRunToken(deployment.id, tfcWorkspace.id, org.id)
  }

  // For apply jobs, look up the saved plan file from the latest successful plan
  let planFileUrl: string | undefined
  if (job.jobType === "apply") {
    try {
      const latestPlan = await findLatestSuccessfulRun(deployment.id, "plan")
      if (latestPlan?.planFileS3Key) {
        const cache = createWorkspaceCache()
        planFileUrl = await cache.getDownloadUrl(latestPlan.planFileS3Key)
        logger.info("runner.context.plan_file_url", {
          jobId,
          planRunId: latestPlan.id,
          s3Key: latestPlan.planFileS3Key,
        })
      }
    } catch (err) {
      logger.warn("runner.context.plan_file_url_failed", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      // Non-fatal: apply will fall back to re-planning
    }
  }

  return c.json({
    data: {
      workspaceUrl,
      command: job.jobType as "plan" | "apply" | "destroy",
      workspacePath: deployment.workspacePath,
      variables,
      executionEnv,
      backendConfig,
      tfcToken,
      planFileUrl,
    },
  })
})

runnerRoute.route("/warm", warmRunnerRoute)
runnerRoute.route("/", runnerJobRoute)
