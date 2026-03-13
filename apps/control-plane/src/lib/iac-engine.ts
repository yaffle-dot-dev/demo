/**
 * IaC Engine
 *
 * Executes a single IaC job (plan, apply, or destroy) and exits.
 * This is the compute unit that runs Terraform commands.
 *
 * Lifecycle:
 * 1. Start with job_id
 * 2. Fetch job details from DB
 * 3. Mark job as running
 * 4. Execute terraform (init, plan, or apply)
 * 5. Record result in DB
 * 6. Mark job as completed or failed
 * 7. Notify downstreams (queue next jobs if ready)
 * 8. Exit
 *
 * The engine sends periodic heartbeats while running so the scheduler
 * can detect if it dies unexpectedly.
 */

import type { TerraformResult } from "@yaffle/shared"

import {
  completeJob,
  failJob,
  getJobWithContext,
  markJobRunning,
  updateJobHeartbeat,
} from "../db/queries/iac-jobs.ts"
import {
  addCompletedUpstream,
  findDownstreamPreviews,
  findPreviewById,
  isPreviewReady,
  markPreviewSkipped,
  updatePreviewStatus,
} from "../db/queries/previews.ts"
import {
  appendRunLog,
  createTfRun,
  updateRunStatus,
} from "../db/queries/tf-runs.ts"
import { createIacJob } from "../db/queries/iac-jobs.ts"
import { events } from "./events.ts"
import { logger } from "./telemetry.ts"
import { LocalRunner } from "./local-runner.ts"
import type { Runner } from "./runner.ts"
import { useTfcBackend } from "./tfc-backend.ts"
import { generateRunToken } from "./run-token.ts"
import { getInstallationToken } from "./github.ts"
import {
  ensurePreviewWorkspace,
  ensureProductionWorkspace,
} from "./workspace-service.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { executeApplyCallbacks } from "./apply-callbacks.ts"
import {
  interpolateVariables,
  parseYaml,
  prVariableContext,
  pushVariableContext,
  validateConfig,
} from "./config.ts"
import { fetchFileContent } from "./github.ts"

const HEARTBEAT_INTERVAL_MS = 30 * 1000 // 30 seconds

/**
 * Execute a single IaC job.
 * This is the main entry point for the IaC engine.
 */
export async function executeJob(jobId: string): Promise<void> {
  const workerId = `engine-${process.pid}-${Date.now()}`

  logger.info("IaC engine starting", { jobId, workerId })

  // Fetch job with context
  const jobContext = await getJobWithContext(jobId)
  if (!jobContext) {
    logger.error("Job not found", { jobId })
    return
  }

  const { preview, ...job } = jobContext

  // Mark job as running
  const runningJob = await markJobRunning(jobId, workerId)
  if (!runningJob) {
    logger.error("Failed to mark job as running", { jobId })
    return
  }

  // Start heartbeat
  const heartbeatTimer = setInterval(() => {
    updateJobHeartbeat(jobId).catch((err) => {
      logger.warn("Failed to update heartbeat", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, HEARTBEAT_INTERVAL_MS)

  try {
    // Execute the job
    const result = await executeJobWork(job, preview, workerId)

    // Stop heartbeat
    clearInterval(heartbeatTimer)

    // Record result
    if (result.success) {
      await completeJob(jobId, {
        output: result.output,
        planSummary: result.planSummary,
        planJson: result.planJson,
        outputs: result.outputs,
        durationMs: result.durationMs,
      })

      // Notify downstreams on successful completion
      await notifyDownstreams(preview.id, job.jobType)
    } else {
      await failJob(jobId, result.errorMessage ?? "Unknown error")

      // Mark downstream previews as skipped
      await cascadeFailure(preview.id)
    }

    logger.info("IaC engine completed", {
      jobId,
      workerId,
      success: result.success,
      durationMs: result.durationMs,
    })
  } catch (err) {
    // Stop heartbeat
    clearInterval(heartbeatTimer)

    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error("IaC engine failed with exception", {
      jobId,
      workerId,
      error: errorMessage,
    })

    await failJob(jobId, errorMessage)
    await cascadeFailure(preview.id)
  }
}

/**
 * Execute the actual terraform work for a job.
 */
async function executeJobWork(
  job: Awaited<ReturnType<typeof getJobWithContext>> extends infer T
    ? T extends undefined ? never : Omit<NonNullable<T>, "preview">
    : never,
  preview: NonNullable<Awaited<ReturnType<typeof getJobWithContext>>>["preview"],
  _workerId: string, // Reserved for future use (e.g., logging/metrics)
): Promise<TerraformResult> {
  const runner: Runner = new LocalRunner()

  // Get organization
  const org = await findOrgById(preview.orgId)
  if (!org) {
    return {
      success: false,
      command: job.jobType as "plan" | "apply" | "destroy",
      output: "",
      errorMessage: "Organization not found",
      durationMs: 0,
    }
  }

  // Get installation token
  let installationToken: string | undefined
  if (preview.installationId) {
    try {
      installationToken = await getInstallationToken(preview.installationId)
    } catch (err) {
      return {
        success: false,
        command: job.jobType as "plan" | "apply" | "destroy",
        output: "",
        errorMessage: `Failed to get installation token: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: 0,
      }
    }
  }

  // Parse owner/repo from preview.repo (format: "owner/repo" or just "repo")
  const repoParts = preview.repo.split("/")
  const owner = repoParts.length > 1 ? repoParts[0] : org.slug
  const repo = repoParts.length > 1 ? repoParts[1] : preview.repo

  // Build variable context (always needed for environment/is_preview injection)
  const isPr = preview.prNumber > 0
  const varCtx = isPr
    ? prVariableContext({
        prNumber: preview.prNumber,
        branch: preview.branch,
        sha: preview.headSha,
        owner,
        repo,
      })
    : pushVariableContext({
        branch: preview.branch,
        sha: preview.headSha,
        owner,
        repo,
      })

  // Fetch config to get workspace-specific variables, then interpolate
  // interpolateVariables always injects environment and is_preview
  let workspaceVars: Record<string, string> | undefined
  if (preview.installationId) {
    try {
      const configRaw = await fetchFileContent(
        preview.installationId,
        owner,
        repo,
        ".yaffle/config.yml",
        preview.headSha,
      )
      if (configRaw) {
        const config = validateConfig(parseYaml(configRaw))
        const workspace = config.workspaces.find((ws) => ws.path === preview.workspacePath)
        workspaceVars = workspace?.variables
      }
    } catch (err) {
      logger.warn("Failed to load config for variables", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Always call interpolateVariables - it injects environment and is_preview
  const variables = interpolateVariables(workspaceVars, varCtx)

  // TFC backend setup
  let tfcWorkspaceId: string | undefined
  let tfcWorkspaceName: string | undefined
  let tfcOrganization: string | undefined
  let tfcToken: string | undefined

  if (useTfcBackend()) {
    const isPr = preview.prNumber > 0
    const tfcWorkspace = isPr
      ? await ensurePreviewWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: preview.repo,
          prNumber: preview.prNumber,
          workspacePath: preview.workspacePath,
          branch: preview.branch,
        })
      : await ensureProductionWorkspace({
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

  // Create a tf_run record
  const tfRun = await createTfRun({
    previewId: preview.id,
    runGroupId: preview.runGroupId ?? undefined,
    runType: job.jobType,
    status: "running",
  })
  events.emitRunUpdate(tfRun.id, preview.id)

  // Update preview status
  const statusMap: Record<string, string> = {
    plan: "planning",
    apply: "applying",
    destroy: "destroying",
  }
  await updatePreviewStatus(preview.id, statusMap[job.jobType] as Parameters<typeof updatePreviewStatus>[1])

  // Execute terraform
  let logBuffer = ""
  const flushLogs = async (): Promise<void> => {
    if (!logBuffer) return
    const chunk = logBuffer
    logBuffer = ""
    try {
      await appendRunLog(tfRun.id, preview.id, chunk)
    } catch (err) {
      logger.warn("Failed to append run logs", {
        runId: tfRun.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Set up periodic log flushing
  const flushInterval = setInterval(() => {
    flushLogs().catch(() => {})
  }, 100)

  let result: TerraformResult
  try {
    result = await runner.run({
      owner,
      repo,
      headSha: preview.headSha,
      command: job.jobType as "plan" | "apply" | "destroy",
      workspacePath: preview.workspacePath,
      stateKey: preview.stateKey,
      variables,
      installationToken,
      runId: tfRun.id,
      prNumber: preview.prNumber > 0 ? preview.prNumber : undefined,
      tfcWorkspaceId,
      tfcWorkspaceName,
      tfcOrganization,
      tfcToken,
      onOutput: (chunk, source) => {
        const entry = source === "stderr" ? `[stderr] ${chunk}` : chunk
        logBuffer += entry
      },
    })
  } finally {
    clearInterval(flushInterval)
    await flushLogs()
  }

  // Update tf_run record
  if (result.success) {
    await updateRunStatus(tfRun.id, preview.id, "success", {
      completedAt: new Date(),
      planSummary: result.planSummary,
      planJson: result.planJson,
      outputs: result.outputs,
    })

    // Update preview status based on job type
    if (job.jobType === "plan") {
      const hasChanges = result.planSummary !== "no changes"
      if (hasChanges) {
        await updatePreviewStatus(preview.id, "awaiting_apply")
      } else {
        await updatePreviewStatus(preview.id, "ready")
      }
    } else if (job.jobType === "apply") {
      await updatePreviewStatus(preview.id, "ready")

      // Execute apply callbacks if configured
      if (preview.installationId && result.outputs) {
        try {
          const configRaw = await fetchFileContent(
            preview.installationId,
            owner,
            repo,
            ".yaffle/config.yml",
            preview.headSha,
          )
          if (configRaw) {
            const config = validateConfig(parseYaml(configRaw))
            const workspace = config.workspaces.find((ws) => ws.path === preview.workspacePath)
            if (workspace?.on_apply) {
              await executeApplyCallbacks(workspace.on_apply, {
                owner,
                repo,
                prNumber: preview.prNumber,
                branch: preview.branch,
                headSha: preview.headSha,
                workspacePath: preview.workspacePath,
                previewId: preview.id,
                outputs: result.outputs,
              }, preview.installationId)
            }
          }
        } catch (err) {
          logger.warn("Failed to execute apply callbacks", {
            previewId: preview.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } else if (job.jobType === "destroy") {
      await updatePreviewStatus(preview.id, "destroyed")
    }
  } else {
    await updateRunStatus(tfRun.id, preview.id, "failed", {
      completedAt: new Date(),
      errorMessage: result.errorMessage,
    })
    await updatePreviewStatus(preview.id, "failed")
  }

  return result
}

/**
 * Notify downstream previews that an upstream has completed.
 * If a downstream is now ready (all upstreams complete), queue its plan job.
 *
 * IMPORTANT: Downstream plans should only start after upstream APPLIES complete,
 * not after plans. This ensures the DAG execution order is respected:
 * - Upstream: plan → apply (with user approval)
 * - Only after upstream apply: Downstream: plan → apply
 *
 * This prevents downstream plans from running with stale upstream state.
 */
async function notifyDownstreams(
  previewId: string,
  completedJobType: string,
): Promise<void> {
  // Only notify downstreams when an APPLY completes, not plans.
  // Downstream workspaces need upstream state to be applied before they can plan.
  if (completedJobType !== "apply") {
    return
  }

  // Find all previews that depend on this one
  const downstreams = await findDownstreamPreviews(previewId)

  if (downstreams.length === 0) {
    logger.debug("No downstream previews to notify", { previewId })
    return
  }

  logger.info("Notifying downstream previews", {
    previewId,
    downstreamCount: downstreams.length,
    downstreamIds: downstreams.map((p) => p.id),
  })

  for (const downstream of downstreams) {
    // Add this preview to downstream's completed_upstreams
    const updated = await addCompletedUpstream(downstream.id, previewId)

    if (!updated) {
      logger.warn("Failed to update downstream completed_upstreams", {
        previewId,
        downstreamId: downstream.id,
      })
      continue
    }

    // Check if downstream is now ready
    if (isPreviewReady(updated)) {
      // Check if it's pending (waiting to plan)
      if (updated.status === "pending") {
        logger.info("Downstream preview now ready, queueing plan", {
          downstreamId: downstream.id,
          workspacePath: downstream.workspacePath,
        })

        // Queue a plan job
        await createIacJob({
          previewId: downstream.id,
          jobType: "plan",
        })
      }
      // Note: we don't auto-queue apply jobs - those require user approval
    } else {
      logger.debug("Downstream preview not yet ready", {
        downstreamId: downstream.id,
        upstreamIds: updated.upstreamIds,
        completedUpstreams: updated.completedUpstreams,
      })
    }
  }
}

/**
 * Cascade failure to all downstream previews.
 * When an upstream fails, all its downstream dependents are marked as skipped.
 */
async function cascadeFailure(previewId: string): Promise<void> {
  // Find all previews that depend on this one
  const downstreams = await findDownstreamPreviews(previewId)

  if (downstreams.length === 0) {
    return
  }

  logger.info("Cascading failure to downstream previews", {
    previewId,
    downstreamCount: downstreams.length,
  })

  const upstream = await findPreviewById(previewId)
  const reason = `Skipped: upstream ${upstream?.workspacePath ?? previewId} failed`

  // Recursively cascade to all downstreams
  const visited = new Set<string>()
  const toProcess = [...downstreams]

  while (toProcess.length > 0) {
    const downstream = toProcess.shift()!

    if (visited.has(downstream.id)) continue
    visited.add(downstream.id)

    // Skip if already in a terminal state
    if (["failed", "destroyed", "ready"].includes(downstream.status)) {
      continue
    }

    // Mark as skipped
    await markPreviewSkipped(downstream.id, reason)

    logger.info("Marked downstream as skipped due to upstream failure", {
      downstreamId: downstream.id,
      workspacePath: downstream.workspacePath,
      reason,
    })

    // Find this downstream's downstreams (transitive)
    const transitiveDownstreams = await findDownstreamPreviews(downstream.id)
    for (const transitive of transitiveDownstreams) {
      if (!visited.has(transitive.id)) {
        toProcess.push(transitive)
      }
    }
  }
}
