/**
 * Standalone IaC Engine
 *
 * A version of the IaC engine that can be imported by external worker processes.
 * This executes terraform but does NOT update job status - that's done by the worker
 * via the runner API.
 *
 * Used by:
 * - apps/runner/src/worker.ts (local development)
 */

import type { TerraformResult } from "@yaffle/shared"

import { getJobWithContext } from "../db/queries/iac-jobs.ts"
import {
  addCompletedUpstreamAtomic,
  claimDestroyJobForUpstream,
  findDownstreamDeployments,
  findDeploymentById,
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
import { getInstallationToken, upsertPrComment } from "./github.ts"
import {
  completeWorkspaceArchive,
  ensureTransientWorkspace,
  ensureNamedWorkspace,
  failWorkspaceArchive,
} from "./workspace-service.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { findDeploymentsByEnvironment } from "../db/queries/workspace-deployments.ts"
import { findLatestRun } from "../db/queries/tf-runs.ts"
import {
  buildExecutionVariables,
  findExecutionSnapshotWorkspace,
  type ExecutionSnapshotV1,
} from "./execution-snapshot.ts"

/**
 * Execute a job standalone (for external worker processes).
 *
 * This does NOT update job status - the worker is responsible for that via API.
 * This does update deployment status and handles downstream notifications.
 */
export async function executeJobStandalone(jobId: string): Promise<TerraformResult> {
  logger.info("Standalone engine executing job", { jobId })

  // Fetch job with context
  const jobContext = await getJobWithContext(jobId)
  if (!jobContext) {
    logger.error("Job not found", { jobId })
    return {
      success: false,
      command: "plan",
      output: "",
      errorMessage: "Job not found",
      durationMs: 0,
    }
  }

  const { deployment, runGroup, ...job } = jobContext

  if (!runGroup?.executionSnapshot) {
    return {
      success: false,
      command: job.jobType as "plan" | "apply" | "destroy",
      output: "",
      errorMessage: "Job is not bound to an immutable execution snapshot",
      durationMs: 0,
    }
  }

  try {
    // Execute the job
    const result = await executeJobWork(job, deployment, runGroup.executionSnapshot)

    // Handle downstream effects based on result
    if (result.success) {
      // Notify dependent workspaces on successful completion
      if (job.jobType === "destroy") {
        // For destroy, notify upstreams (reverse DAG order)
        await notifyDestroyComplete(deployment.id, job.runGroupId)
      } else {
        // For plan/apply, notify downstreams (forward DAG order)
        await notifyDownstreams(deployment.id, job.jobType, job.runGroupId)
      }
    } else {
      // Mark downstream deployments as skipped
      await cascadeFailure(deployment.id)
    }

    logger.info("Standalone engine completed", {
      jobId,
      success: result.success,
      durationMs: result.durationMs,
    })

    return result
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error("Standalone engine failed with exception", {
      jobId,
      error: errorMessage,
    })

    await cascadeFailure(deployment.id)

    return {
      success: false,
      command: job.jobType as "plan" | "apply" | "destroy",
      output: "",
      errorMessage,
      durationMs: 0,
    }
  }
}

/**
 * Execute the actual terraform work for a job.
 */
async function executeJobWork(
  job: Awaited<ReturnType<typeof getJobWithContext>> extends infer T
    ? T extends undefined ? never : Omit<NonNullable<T>, "deployment" | "preview" | "runGroup">
    : never,
  deployment: NonNullable<Awaited<ReturnType<typeof getJobWithContext>>>["deployment"],
  executionSnapshot: ExecutionSnapshotV1,
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
  if (executionSnapshot.source.installationId) {
    try {
      installationToken = await getInstallationToken(executionSnapshot.source.installationId)
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

  const { source, environment } = executionSnapshot
  const owner = source.owner
  const repo = source.repository
  const environmentKind = environment.kind
  const environmentName = environment.name
  const workspace = findExecutionSnapshotWorkspace(executionSnapshot, deployment.workspacePath)
  const variables = buildExecutionVariables(executionSnapshot, deployment.workspacePath)
  if (!workspace || !variables) {
    return {
      success: false,
      command: job.jobType as "plan" | "apply" | "destroy",
      output: "",
      errorMessage: "Workspace is not present in the job execution snapshot",
      durationMs: 0,
    }
  }

  // TFC backend setup
  let tfcWorkspaceId: string | undefined
  let tfcWorkspaceName: string | undefined
  let tfcOrganization: string | undefined
  let tfcToken: string | undefined

  if (useTfcBackend()) {
    const tfcWorkspace = environmentKind === "transient"
      ? await ensureTransientWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: source.repository,
          environment: environmentName,
          workspacePath: deployment.workspacePath,
          ref: source.ref,
        })
      : await ensureNamedWorkspace({
          orgId: org.id,
          orgSlug: org.slug,
          repo: source.repository,
          environment: environmentName,
          ref: source.ref,
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
    runGroupId: job.runGroupId ?? undefined,
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
      headSha: source.commitSha,
      command: job.jobType as "plan" | "apply" | "destroy",
      workspacePath: deployment.workspacePath,
      stateKey: deployment.stateKey,
      variables,
      installationToken,
      runId: tfRun.id,
      prNumber: environment.sourcePullRequestNumber ?? undefined,
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

        const skippedApply = await createTfRun({
          deploymentId: deployment.id,
          runGroupId: job.runGroupId ?? undefined,
          runType: "apply",
          status: "skipped",
        })
        events.emitRunUpdate(skippedApply.id, deployment.id)

        await notifyDownstreams(deployment.id, "apply", job.runGroupId)
      }
    } else if (job.jobType === "apply") {
      await updateDeploymentStatus(deployment.id, "ready")
    } else if (job.jobType === "destroy") {
      await updateDeploymentStatus(deployment.id, "destroyed")

      if (tfcWorkspaceId) {
        await completeWorkspaceArchive(tfcWorkspaceId)
        logger.info("TFC workspace archived after destroy", {
          tfcWorkspaceId,
          deploymentId: deployment.id,
        })
      }
    }

    await updatePrCommentFromDb(deployment)
  } else {
    await updateRunStatus(tfRun.id, deployment.id, "failed", {
      completedAt: new Date(),
      errorMessage: result.errorMessage,
    })
    await updateDeploymentStatus(deployment.id, "failed")

    if (job.jobType === "destroy" && tfcWorkspaceId) {
      await failWorkspaceArchive(tfcWorkspaceId, result.errorMessage ?? "destroy failed")
    }

    await updatePrCommentFromDb(deployment)
  }

  return result
}

// ---------------------------------------------------------------------------
// Downstream Notification (copied from iac-engine.ts)
// ---------------------------------------------------------------------------

async function notifyDownstreams(
  previewId: string,
  completedJobType: string,
  runGroupId: string | null,
): Promise<void> {
  if (completedJobType !== "apply") {
    return
  }

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
    const result = await addCompletedUpstreamAtomic(downstream.id, previewId)

    if (!result) {
      logger.warn("Failed to update downstream completed_upstreams", {
        previewId,
        downstreamId: downstream.id,
      })
      continue
    }

    if (result.shouldQueueJob) {
      logger.info("Downstream preview now ready, queueing plan (won race)", {
        downstreamId: downstream.id,
        workspacePath: result.deployment.workspacePath,
      })

      await createIacJob({
        deploymentId: downstream.id,
        runGroupId,
        jobType: "plan",
      })
    } else if (result.deployment.status === "planning") {
      logger.debug("Downstream preview ready but another thread is queueing", {
        downstreamId: downstream.id,
        workspacePath: result.deployment.workspacePath,
      })
    } else {
      logger.debug("Downstream preview not yet ready", {
        downstreamId: downstream.id,
        upstreamIds: result.deployment.upstreamIds,
        completedUpstreams: result.deployment.completedUpstreams,
        status: result.deployment.status,
      })
    }
  }
}

async function cascadeFailure(previewId: string): Promise<void> {
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

  const visited = new Set<string>()
  const toProcess = [...downstreams]

  while (toProcess.length > 0) {
    const downstream = toProcess.shift()!

    if (visited.has(downstream.id)) continue
    visited.add(downstream.id)

    if (["failed", "destroyed", "ready"].includes(downstream.status)) {
      continue
    }

    await markDeploymentSkipped(downstream.id, reason)

    logger.info("Marked downstream as skipped due to upstream failure", {
      downstreamId: downstream.id,
      workspacePath: downstream.workspacePath,
      reason,
    })

    const transitiveDownstreams = await findDownstreamDeployments(downstream.id)
    for (const transitive of transitiveDownstreams) {
      if (!visited.has(transitive.id)) {
        toProcess.push(transitive)
      }
    }
  }
}

async function notifyDestroyComplete(
  deploymentId: string,
  runGroupId: string | null,
): Promise<void> {
  const deployment = await findDeploymentById(deploymentId)
  if (!deployment) return

  if (!deployment.upstreamIds || deployment.upstreamIds.length === 0) {
    logger.debug("No upstream deployments to notify for destroy", { deploymentId })
    return
  }

  logger.info("Checking if upstream deployments can be destroyed", {
    deploymentId,
    upstreamCount: deployment.upstreamIds.length,
  })

  for (const upstreamId of deployment.upstreamIds) {
    const downstreams = await findDownstreamDeployments(upstreamId)
    const allDestroyed = downstreams.every((d) => d.status === "destroyed")

    if (allDestroyed) {
      const result = await claimDestroyJobForUpstream(upstreamId)

      if (result.claimed && result.deployment) {
        await createIacJob({
          deploymentId: upstreamId,
          runGroupId,
          jobType: "destroy",
        })

        logger.info("Queued destroy job for upstream after all downstreams destroyed (won race)", {
          upstreamId,
          workspacePath: result.deployment.workspacePath,
          destroyedDownstreams: downstreams.map((d) => d.workspacePath),
        })
      } else {
        logger.debug("Upstream destroy already claimed by another thread", {
          upstreamId,
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

const PR_COMMENT_MARKER = "<!-- yaffle:pr -->"

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
      return latestRunType === "apply" ? "apply_failed" : "plan_failed"
    default:
      return "planning"
  }
}

async function updatePrCommentFromDb(
  deployment: { id: string; orgId: string; repo: string; prNumber: number | null; installationId: number | null; environmentName: string; headSha: string },
): Promise<void> {
  if (!deployment.prNumber || !deployment.installationId) {
    return
  }

  try {
    const org = await findOrgById(deployment.orgId)
    if (!org) return

    const siblings = await findDeploymentsByEnvironment(
      deployment.orgId,
      deployment.repo,
      deployment.environmentName,
    )

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

    const body = renderCommentFromStates(deployment.headSha, workspaceStates)

    const repoParts = deployment.repo.split("/")
    const owner = repoParts.length > 1 ? repoParts[0] : org.slug
    const repo = repoParts.length > 1 ? repoParts[1] : deployment.repo

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
    logger.warn("Failed to update PR comment", {
      deploymentId: deployment.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

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

  lines.push("| Workspace | Status |")
  lines.push("|-----------|--------|")

  for (const ws of workspaces) {
    const displayPath = ws.workspacePath === "." ? "root" : ws.workspacePath
    const { icon, label } = phaseDisplay(ws)
    lines.push(`| \`${displayPath}\` | ${icon} ${label} |`)
  }

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
