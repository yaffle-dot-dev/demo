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
import { updateDeploymentStatus } from "../db/queries/workspace-deployments.ts"
import { findRunGroupById } from "../db/queries/run-groups.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { createTfRun, appendRunLog, updateRunStatus } from "../db/queries/tf-runs.ts"
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
import { generateRunToken, getTfcApiHost } from "../lib/run-token.ts"
import { createWorkspaceCache } from "../lib/workspace-cache.ts"

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

  if (!jobContext?.deployment) {
    // Should never happen - claim succeeded but job context not found
    logger.error("runner.claim.missing_context", { jobId })
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Job context not found after claim" } },
      500,
    )
  }

  const { deployment } = jobContext

  // Create tf_run record for this job execution
  // This is where logs will be streamed and results stored
  const tfRun = await createTfRun({
    deploymentId: deployment.id,
    runGroupId: deployment.runGroupId ?? undefined,
    runType: result.job!.jobType,
    status: "running",
    startedAt: new Date(),
  })
  events.emitRunUpdate(tfRun.id, deployment.id)

  // Update deployment status based on job type
  const statusMap: Record<string, "planning" | "applying" | "destroying"> = {
    plan: "planning",
    apply: "applying",
    destroy: "destroying",
  }
  const deploymentStatus = statusMap[result.job!.jobType]
  if (deploymentStatus) {
    await updateDeploymentStatus(deployment.id, deploymentStatus)
  }

  // Emit deployment update so the DAG UI shows "running" status
  events.emitDeploymentUpdate(
    deployment.id,
    deployment.orgId,
    deployment.repo,
    deployment.environmentKind as EnvironmentKind,
    deployment.environmentName,
  )

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
      runId: tfRun.id,  // Worker needs this for log streaming
      deployment,
    },
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
runnerRoute.post("/logs", async (c) => {
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

  // Append to run logs
  await appendRunLog(runId, auth.jobToken.deployment_id, formattedChunk)

  return c.json({ data: { success: true } })
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
      const planSummary = typeof result?.planSummary === "string" ? result.planSummary : undefined
      await updateRunStatus(runId, deployment.id, "success", {
        completedAt: new Date(),
        planSummary,
        planJson: result?.planJson,
        outputs: result?.outputs,
      })

      if (jobType === "plan") {
        const hasChanges = planSummary !== "no changes"
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
        }
      } else if (jobType === "apply") {
        await updateDeploymentStatus(deployment.id, "ready")
      } else if (jobType === "destroy") {
        await updateDeploymentStatus(deployment.id, "destroyed")
      }
    }
  } else {
    const failResult = await failJobFromRunner(jobId, errorMessage ?? "Unknown error")
    success = failResult.success

    if (success) {
      await updateRunStatus(runId, deployment.id, "failed", {
        completedAt: new Date(),
        errorMessage: errorMessage ?? "Unknown error",
      })
      await updateDeploymentStatus(deployment.id, "failed")
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
 */
runnerRoute.get("/job/:jobId/context", async (c) => {
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
      hostname: getTfcApiHost(),
      organization: org.slug,
      workspaceName: tfcWorkspace.name,
    }
    tfcToken = await generateRunToken(deployment.id, tfcWorkspace.id, org.id)
  }

  return c.json({
    data: {
      workspaceUrl,
      command: job.jobType as "plan" | "apply" | "destroy",
      workspacePath: deployment.workspacePath,
      variables,
      backendConfig,
      tfcToken,
    },
  })
})
