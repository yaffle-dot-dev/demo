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
  findDownstreamDeployments,
  findDeploymentById,
  isDeploymentReady,
  markDeploymentSkipped,
  updateDeploymentStatus,
} from "../db/queries/workspace-deployments.ts"
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
  completeWorkspaceArchive,
  ensurePreviewWorkspace,
  ensureNamedWorkspace,
  failWorkspaceArchive,
} from "./workspace-service.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import {
  type Workspace,
  buildPrEnvironmentName,
  parseYaffleToml,
} from "./config-toml.ts"
import { fetchFileContent, upsertPrComment } from "./github.ts"
import { findDeploymentsByEnvironment } from "../db/queries/workspace-deployments.ts"
import { findLatestRun } from "../db/queries/tf-runs.ts"
import { renderVariables, TemplateError, type TemplateContext } from "./templating.ts"

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

  const { deployment, ...job } = jobContext

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
    const result = await executeJobWork(job, deployment, workerId)

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

      // Notify dependent workspaces on successful completion
      if (job.jobType === "destroy") {
        // For destroy, notify upstreams (reverse DAG order)
        await notifyDestroyComplete(deployment.id)
      } else {
        // For plan/apply, notify downstreams (forward DAG order)
        await notifyDownstreams(deployment.id, job.jobType)
      }
    } else {
      await failJob(jobId, result.errorMessage ?? "Unknown error")

      // Mark downstream deployments as skipped
      await cascadeFailure(deployment.id)
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
    await cascadeFailure(deployment.id)
  }
}

/**
 * Execute the actual terraform work for a job.
 */
async function executeJobWork(
  job: Awaited<ReturnType<typeof getJobWithContext>> extends infer T
    ? T extends undefined ? never : Omit<NonNullable<T>, "deployment" | "preview">
    : never,
  deployment: NonNullable<Awaited<ReturnType<typeof getJobWithContext>>>["deployment"],
  _workerId: string, // Reserved for future use (e.g., logging/metrics)
): Promise<TerraformResult> {
  const runner: Runner = new LocalRunner()

  // Get organization
  const org = await findOrgById(deployment.orgId)
  if (!org) {
    return {
      success: false,
      command: job.jobType as "plan" | "apply" | "destroy",
      output: "",
      errorMessage: "Organization not found",
      durationMs: 0,
    }
  }

  // Check org provisioning status - block runs until AWS resources are ready
  if (org.provisioningStatus !== "active") {
    const errorMessage = org.provisioningStatus === "failed"
      ? "Organization provisioning failed. Support has been notified and will contact you shortly."
      : `Organization is being set up (status: ${org.provisioningStatus}). Please wait a moment and try again.`

    return {
      success: false,
      command: job.jobType as "plan" | "apply" | "destroy",
      output: "",
      errorMessage,
      durationMs: 0,
    }
  }

  // Get installation token
  let installationToken: string | undefined
  if (deployment.installationId) {
    try {
      installationToken = await getInstallationToken(deployment.installationId)
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

  // Parse owner/repo from deployment.repo (format: "owner/repo" or just "repo")
  const repoParts = deployment.repo.split("/")
  const owner = repoParts.length > 1 ? repoParts[0] : org.slug
  const repo = repoParts.length > 1 ? repoParts[1] : deployment.repo

  // Determine environment kind and name
  const isPr = deployment.prNumber != null && deployment.prNumber > 0
  const environmentKind = isPr ? "transient" : "named"
  const environmentName = isPr
    ? buildPrEnvironmentName(deployment.prNumber!)
    : deployment.branch

  // Fetch config to get workspace-specific variables
  let workspace: Workspace | undefined
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
        workspace = config.workspaces.find((ws) => ws.path === deployment.workspacePath)
      }
    } catch (err) {
      logger.warn("Failed to load config for variables", {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Build variables - always inject environment and environment_kind
  // Then render workspace-level variables with template substitution
  const variables: Record<string, string | boolean | number> = {
    environment: environmentName,
    environment_kind: environmentKind,
  }
  if (workspace?.variables) {
    // Build template context for variable rendering
    const templateContext: TemplateContext = {
      environment: environmentName,
      environment_kind: environmentKind,
      org: owner,
      repo,
      workspace_path: deployment.workspacePath,
      branch: deployment.branch,
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
        return {
          success: false,
          command: job.jobType as "plan" | "apply" | "destroy",
          output: "",
          errorMessage: err.message,
          durationMs: 0,
        }
      }
      throw err
    }
  }

  // TFC backend setup
  let tfcWorkspaceId: string | undefined
  let tfcWorkspaceName: string | undefined
  let tfcOrganization: string | undefined
  let tfcToken: string | undefined

  if (useTfcBackend()) {
    const isPrForTfc = deployment.prNumber != null && deployment.prNumber > 0
    const tfcWorkspace = isPrForTfc
      ? await ensurePreviewWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: deployment.repo,
          environment: environmentName,
          prNumber: deployment.prNumber!, // Non-null assertion safe: isPrForTfc guard ensures this
          workspacePath: deployment.workspacePath,
          branch: deployment.branch,
        })
      : await ensureNamedWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: deployment.repo,
          environment: environmentName,
          branch: deployment.branch,
          workspacePath: deployment.workspacePath,
        })

    tfcWorkspaceId = tfcWorkspace.id
    tfcWorkspaceName = tfcWorkspace.name
    tfcOrganization = org.slug
    tfcToken = await generateRunToken(deployment.id, tfcWorkspace.id, org.id)
  }

  // Create a tf_run record
  const tfRun = await createTfRun({
    deploymentId: deployment.id,
    runGroupId: deployment.runGroupId ?? undefined,
    runType: job.jobType,
    status: "running",
  })
  events.emitRunUpdate(tfRun.id, deployment.id)

  // Update deployment status
  const statusMap: Record<string, string> = {
    plan: "planning",
    apply: "applying",
    destroy: "destroying",
  }
  await updateDeploymentStatus(deployment.id, statusMap[job.jobType] as Parameters<typeof updateDeploymentStatus>[1])

  // Execute terraform
  let logBuffer = ""
  const flushLogs = async (): Promise<void> => {
    if (!logBuffer) return
    const chunk = logBuffer
    logBuffer = ""
    try {
      await appendRunLog(tfRun.id, deployment.id, chunk)
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
      headSha: deployment.headSha,
      command: job.jobType as "plan" | "apply" | "destroy",
      workspacePath: deployment.workspacePath,
      stateKey: deployment.stateKey,
      variables,
      installationToken,
      runId: tfRun.id,
      prNumber: deployment.prNumber != null && deployment.prNumber > 0 ? deployment.prNumber : undefined,
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
    await updateRunStatus(tfRun.id, deployment.id, "success", {
      completedAt: new Date(),
      planSummary: result.planSummary,
      planJson: result.planJson,
      outputs: result.outputs,
    })

    // Update deployment status based on job type
    if (job.jobType === "plan") {
      const hasChanges = result.planSummary !== "no changes"
      if (hasChanges) {
        await updateDeploymentStatus(deployment.id, "awaiting_apply")
      } else {
        await updateDeploymentStatus(deployment.id, "ready")
      }
    } else if (job.jobType === "apply") {
      await updateDeploymentStatus(deployment.id, "ready")
      // Note: on_apply callbacks have been removed from TOML config.
      // Use GitHub Actions for post-apply workflows.
    } else if (job.jobType === "destroy") {
      await updateDeploymentStatus(deployment.id, "destroyed")

      // Complete TFC workspace archival if applicable
      if (tfcWorkspaceId) {
        await completeWorkspaceArchive(tfcWorkspaceId)
        logger.info("TFC workspace archived after destroy", {
          tfcWorkspaceId,
          deploymentId: deployment.id,
        })
      }
    }

    // Update PR comment after any successful job completion
    await updatePrCommentFromDb(deployment)
  } else {
    await updateRunStatus(tfRun.id, deployment.id, "failed", {
      completedAt: new Date(),
      errorMessage: result.errorMessage,
    })
    await updateDeploymentStatus(deployment.id, "failed")

    // Fail TFC workspace archival if this was a destroy
    if (job.jobType === "destroy" && tfcWorkspaceId) {
      await failWorkspaceArchive(tfcWorkspaceId, result.errorMessage ?? "destroy failed")
    }

    // Update PR comment after failure too
    await updatePrCommentFromDb(deployment)
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
  const downstreams = await findDownstreamDeployments(previewId)

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
    if (isDeploymentReady(updated)) {
      // Check if it's pending (waiting to plan)
      if (updated.status === "pending") {
        logger.info("Downstream preview now ready, queueing plan", {
          downstreamId: downstream.id,
          workspacePath: downstream.workspacePath,
        })

        // Queue a plan job
        await createIacJob({
          deploymentId: downstream.id,
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
  const downstreams = await findDownstreamDeployments(previewId)

  if (downstreams.length === 0) {
    return
  }

  logger.info("Cascading failure to downstream previews", {
    previewId,
    downstreamCount: downstreams.length,
  })

  const upstream = await findDeploymentById(previewId)
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
    await markDeploymentSkipped(downstream.id, reason)

    logger.info("Marked downstream as skipped due to upstream failure", {
      downstreamId: downstream.id,
      workspacePath: downstream.workspacePath,
      reason,
    })

    // Find this downstream's downstreams (transitive)
    const transitiveDownstreams = await findDownstreamDeployments(downstream.id)
    for (const transitive of transitiveDownstreams) {
      if (!visited.has(transitive.id)) {
        toProcess.push(transitive)
      }
    }
  }
}

/**
 * Notify upstream workspaces that a downstream destroy has completed.
 * When all of an upstream's downstreams are destroyed, queue its destroy job.
 *
 * This is the reverse of notifyDownstreams - for destroy operations,
 * we work backward through the DAG (downstream first, then upstream).
 */
async function notifyDestroyComplete(deploymentId: string): Promise<void> {
  const deployment = await findDeploymentById(deploymentId)
  if (!deployment) return

  // No upstreams = nothing to notify
  if (!deployment.upstreamIds || deployment.upstreamIds.length === 0) {
    logger.debug("No upstream deployments to notify for destroy", { deploymentId })
    return
  }

  logger.info("Checking if upstream deployments can be destroyed", {
    deploymentId,
    upstreamCount: deployment.upstreamIds.length,
  })

  for (const upstreamId of deployment.upstreamIds) {
    // Find all downstreams of this upstream
    const downstreams = await findDownstreamDeployments(upstreamId)

    // Check if all downstreams are now destroyed
    const allDestroyed = downstreams.every((d) => d.status === "destroyed")

    if (allDestroyed) {
      const upstream = await findDeploymentById(upstreamId)

      // Only queue destroy if upstream is in pending state (waiting for destroy)
      if (upstream?.status === "pending") {
        await createIacJob({
          deploymentId: upstreamId,
          jobType: "destroy",
        })

        logger.info("Queued destroy job for upstream after all downstreams destroyed", {
          upstreamId,
          workspacePath: upstream.workspacePath,
          destroyedDownstreams: downstreams.map((d) => d.workspacePath),
        })
      } else {
        logger.debug("Upstream not in pending state, skipping destroy queue", {
          upstreamId,
          status: upstream?.status,
        })
      }
    } else {
      const pendingDownstreams = downstreams.filter((d) => d.status !== "destroyed")
      logger.debug("Upstream still has non-destroyed downstreams", {
        upstreamId,
        pendingCount: pendingDownstreams.length,
        pendingPaths: pendingDownstreams.map((d) => d.workspacePath),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// PR Comment Updates
// ---------------------------------------------------------------------------

/** The single HTML marker for the consolidated Yaffle PR comment. */
const PR_COMMENT_MARKER = "<!-- yaffle:pr -->"

/** Deployment status to comment phase mapping. */
type CommentPhase =
  | "planning"
  | "plan_success"
  | "plan_failed"
  | "applying"
  | "ready"
  | "apply_failed"
  | "destroying"
  | "destroyed"

function statusToPhase(status: string, latestRunType?: string): CommentPhase {
  switch (status) {
    case "planning":
      return "planning"
    case "awaiting_apply":
      return "plan_success"
    case "applying":
      return "applying"
    case "ready":
      return "ready"
    case "destroying":
      return "destroying"
    case "destroyed":
      return "destroyed"
    case "failed":
      // Determine if it was plan or apply that failed
      return latestRunType === "apply" ? "apply_failed" : "plan_failed"
    default:
      return "planning" // pending or unknown
  }
}

/**
 * Update the PR comment by querying all sibling deployments from DB.
 * This is stateless - can be called from any process.
 */
async function updatePrCommentFromDb(
  deployment: { id: string; orgId: string; repo: string; prNumber: number | null; installationId: number | null; environmentName: string; headSha: string },
): Promise<void> {
  // Only for PR environments with installation
  if (!deployment.prNumber || !deployment.installationId) {
    return
  }

  try {
    const org = await findOrgById(deployment.orgId)
    if (!org) return

    // Find all sibling deployments in this PR environment
    const siblings = await findDeploymentsByEnvironment(
      deployment.orgId,
      deployment.repo,
      deployment.environmentName,
    )

    // Query latest run for each to get plan summaries, outputs, etc.
    const workspaceStates = await Promise.all(
      siblings.map(async (d) => {
        const latestRun = await findLatestRun(d.id)
        return {
          workspacePath: d.workspacePath,
          status: d.status,
          phase: statusToPhase(d.status, latestRun?.runType),
          planSummary: latestRun?.planSummary ?? undefined,
          outputs: latestRun?.outputs as Record<string, unknown> | undefined,
          errorMessage: latestRun?.errorMessage ?? undefined,
        }
      }),
    )

    // Render comment body
    const body = renderCommentFromStates(deployment.headSha, workspaceStates)

    // Parse owner/repo
    const repoParts = deployment.repo.split("/")
    const owner = repoParts.length > 1 ? repoParts[0] : org.slug
    const repo = repoParts.length > 1 ? repoParts[1] : deployment.repo

    // Upsert to GitHub
    await upsertPrComment(
      deployment.installationId,
      owner,
      repo,
      deployment.prNumber,
      body,
      PR_COMMENT_MARKER,
    )

    logger.info("Updated PR comment from DB state", {
      prNumber: deployment.prNumber,
      workspaceCount: workspaceStates.length,
    })
  } catch (err) {
    // Don't fail the job if comment update fails
    logger.warn("Failed to update PR comment", {
      deploymentId: deployment.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Render the full consolidated PR comment from workspace states.
 */
function renderCommentFromStates(
  headSha: string,
  workspaces: Array<{
    workspacePath: string
    status: string
    phase: CommentPhase
    planSummary?: string
    outputs?: Record<string, unknown>
    errorMessage?: string
  }>,
): string {
  const shortSha = headSha.slice(0, 7)
  const lines: string[] = [PR_COMMENT_MARKER, `### Yaffle \`${shortSha}\``, ""]

  // Status table
  lines.push("| Workspace | Status |")
  lines.push("|-----------|--------|")

  for (const ws of workspaces) {
    const displayPath = ws.workspacePath === "." ? "root" : ws.workspacePath
    const { icon, label } = phaseDisplay(ws)
    lines.push(`| \`${displayPath}\` | ${icon} ${label} |`)
  }

  // Outputs sections (collapsible, one per workspace that has outputs)
  const outputSections: string[] = []
  for (const ws of workspaces) {
    if (ws.phase !== "ready" || !ws.outputs) continue
    const entries = Object.entries(ws.outputs)
    if (entries.length === 0) continue

    const displayPath = ws.workspacePath === "." ? "root" : ws.workspacePath
    const section = renderOutputsSection(displayPath, ws.outputs)
    if (section) outputSections.push(section)
  }

  if (outputSections.length > 0) {
    lines.push("")
    lines.push(outputSections.join("\n\n"))
  }

  return lines.join("\n")
}

function phaseDisplay(ws: { phase: CommentPhase; planSummary?: string; errorMessage?: string }): { icon: string; label: string } {
  switch (ws.phase) {
    case "planning":
      return { icon: "\u23f3", label: "Planning..." }
    case "plan_success":
      return { icon: "\u2705", label: `Plan: ${ws.planSummary ?? "complete"}` }
    case "plan_failed":
      return { icon: "\u274c", label: `Plan failed${ws.errorMessage ? `: ${ws.errorMessage}` : ""}` }
    case "applying":
      return { icon: "\u23f3", label: `Applying (${ws.planSummary ?? "..."})` }
    case "ready":
      return { icon: "\u2705", label: "Preview ready" }
    case "apply_failed":
      return { icon: "\u274c", label: `Apply failed${ws.errorMessage ? `: ${ws.errorMessage}` : ""}` }
    case "destroying":
      return { icon: "\ud83d\uddd1\ufe0f", label: "Destroying..." }
    case "destroyed":
      return { icon: "\ud83d\uddd1\ufe0f", label: "Destroyed" }
  }
}

/** Standard terraform output -json shape per key. */
interface TerraformOutput {
  value: unknown
  type?: unknown
  sensitive?: boolean
}

function renderOutputsSection(
  displayPath: string,
  outputs: Record<string, unknown>,
): string | undefined {
  const entries = Object.entries(outputs)
  if (entries.length === 0) return undefined

  const lines: string[] = [
    "<details>",
    `<summary><code>${displayPath}</code> outputs</summary>`,
    "",
    "| Output | Value |",
    "|--------|-------|",
  ]

  entries
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, raw]) => {
      const output = raw as TerraformOutput
      const value = output.sensitive
        ? "*(sensitive)*"
        : formatValue(output.value)
      lines.push(`| \`${name}\` | ${value} |`)
    })

  lines.push("")
  lines.push("</details>")

  return lines.join("\n")
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ""

  if (typeof value === "string") return `\`${value}\``
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``

  const json = JSON.stringify(value)
  if (json.length <= 80) return `\`${json}\``

  return `<details><summary>complex value</summary>\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n</details>`
}
