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

import { verifyJobToken, type JobTokenPayload } from "../lib/job-token.ts"
import { logger } from "../lib/telemetry.ts"
import {
  claimJobForRunner,
  heartbeatJob,
  completeJobFromRunner,
  failJobFromRunner,
  getJobWithContext,
} from "../db/queries/iac-jobs.ts"
import { findDeploymentById } from "../db/queries/workspace-deployments.ts"
import { events } from "../lib/events.ts"
import type { EnvironmentKind } from "../lib/config-toml.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerAuthContext {
  jobToken: JobTokenPayload
}

type RunnerVariables = {
  runnerAuth: RunnerAuthContext
}

export const runnerRoute = new Hono<{ Variables: RunnerVariables }>()

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }
  return authHeader.slice(7)
}

/**
 * Runner authentication middleware.
 * Verifies job token and sets context.
 */
runnerRoute.use("*", async (c, next) => {
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
runnerRoute.post("/claim", async (c) => {
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
  const result = await claimJobForRunner(jobId, workerId)

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

  // Emit events for real-time UI updates (job now running)
  events.emitJobUpdate(jobId, result.job!.deploymentId)

  // Get full job context for the runner
  const jobContext = await getJobWithContext(jobId)

  // Emit deployment update so the DAG UI shows "running" status
  if (jobContext?.deployment) {
    events.emitDeploymentUpdate(
      jobContext.deployment.id,
      jobContext.deployment.orgId,
      jobContext.deployment.repo,
      jobContext.deployment.environmentKind as EnvironmentKind,
      jobContext.deployment.environmentName,
    )
  }

  return c.json({
    data: {
      claimed: true,
      job: {
        id: result.job!.id,
        jobType: result.job!.jobType,
        deploymentId: result.job!.deploymentId,
        queuedAt: result.job!.queuedAt,
        startedAt: result.job!.startedAt,
      },
      deployment: jobContext?.deployment,
    },
  })
})

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
runnerRoute.post("/heartbeat", async (c) => {
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
runnerRoute.post("/complete", async (c) => {
  const auth = c.get("runnerAuth") as RunnerAuthContext
  const body = await c.req.json()

  const parsed = completeBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid request body", details: parsed.error.issues } },
      400,
    )
  }

  const { jobId, status, result, errorMessage } = parsed.data

  // Verify job token matches
  if (auth.jobToken.job_id !== jobId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Job token does not match job ID" } },
      403,
    )
  }

  let success: boolean
  if (status === "completed") {
    const completeResult = await completeJobFromRunner(jobId, result ?? {})
    success = completeResult.success
  } else {
    const failResult = await failJobFromRunner(jobId, errorMessage ?? "Unknown error")
    success = failResult.success
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
  const deployment = await findDeploymentById(auth.jobToken.deployment_id)
  if (deployment) {
    events.emitDeploymentUpdate(
      deployment.id,
      deployment.orgId,
      deployment.repo,
      deployment.environmentKind as EnvironmentKind,
      deployment.environmentName,
    )
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
runnerRoute.get("/job/:jobId", async (c) => {
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
