import {
  archiveWorkspace,
  findWorkspaceById,
  findWorkspaceByName,
  findWorkspacesByPr,
  forceUnlockWorkspace,
  lockWorkspace,
  updateWorkspaceStatus,
  type Workspace,
} from "../db/queries/workspaces.ts"
import { logger } from "./telemetry.ts"

/**
 * Archive a preview workspace.
 *
 * This is called when a PR is closed (merged or not).
 * The actual terraform destroy happens separately in the webhook handler.
 *
 * Flow:
 * 1. Lock workspace with "system:cleanup" to prevent concurrent operations
 * 2. Set status to "destroying"
 * 3. (Caller runs terraform destroy)
 * 4. Set status to "archived" and unlock
 *
 * If destroy fails, status is set to "destroying" and the workspace remains locked.
 * Admin can retry or force-archive later.
 */
export async function beginWorkspaceArchive(
  workspaceId: string,
): Promise<Workspace | null> {
  const workspace = await findWorkspaceById(workspaceId)
  if (!workspace) {
    logger.warn("Cannot archive workspace: not found", { workspaceId })
    return null
  }

  if (workspace.status === "archived") {
    logger.info("Workspace already archived", { workspaceId })
    return workspace
  }

  // Lock the workspace for cleanup
  const locked = await lockWorkspace(workspaceId, "system:cleanup", "Destroying preview")
  if (!locked) {
    // Already locked - check if it's us from a previous attempt
    if (workspace.lockedBy === "system:cleanup") {
      logger.info("Workspace already locked for cleanup, resuming", { workspaceId })
      return workspace
    }

    logger.warn("Cannot lock workspace for archive: already locked", {
      workspaceId,
      lockedBy: workspace.lockedBy ?? undefined,
    })
    return null
  }

  // Set status to destroying
  await updateWorkspaceStatus(workspaceId, "destroying")
  logger.info("Workspace locked for destruction", { workspaceId })

  return locked
}

/**
 * Complete the archive after successful destroy.
 */
export async function completeWorkspaceArchive(workspaceId: string): Promise<Workspace | null> {
  const archived = await archiveWorkspace(workspaceId)
  if (!archived) {
    logger.error("Failed to archive workspace", { workspaceId })
    return null
  }

  logger.info("Workspace archived", { workspaceId })
  return archived
}

/**
 * Mark workspace archive as failed.
 * Leaves the workspace locked so it can be retried or force-archived.
 */
export async function failWorkspaceArchive(
  workspaceId: string,
  errorMessage: string,
): Promise<void> {
  // Status stays as "destroying" but we log the failure
  // The lock remains so admins can investigate
  logger.error("Workspace archive failed", { workspaceId, error: errorMessage })
}

/**
 * Force archive a workspace without running destroy.
 * Use this for:
 * - Workspaces that failed destroy and need manual cleanup
 * - Workspaces where the infrastructure was already deleted externally
 */
export async function forceArchiveWorkspace(workspaceId: string): Promise<Workspace | null> {
  // Force unlock first if locked
  await forceUnlockWorkspace(workspaceId)

  // Then archive
  const archived = await archiveWorkspace(workspaceId)
  if (!archived) {
    logger.error("Failed to force archive workspace", { workspaceId })
    return null
  }

  logger.info("Workspace force archived", { workspaceId })
  return archived
}

/**
 * Find or create a TFC workspace for a preview.
 */
export async function ensurePreviewWorkspace(opts: {
  orgId: string
  orgSlug: string
  repo: string
  environment: string
  prNumber: number
  workspacePath: string
  branch: string
}): Promise<Workspace> {
  const { buildWorkspaceName, createWorkspace } = await import("../db/queries/workspaces.ts")

  const workspaceName = buildWorkspaceName(opts.repo, opts.environment, opts.branch, opts.workspacePath)

  // Check if workspace already exists
  let workspace = await findWorkspaceByName(opts.orgId, workspaceName)
  if (workspace) {
    // Reactivate if archived
    if (workspace.status === "archived") {
      await updateWorkspaceStatus(workspace.id, "active")
      workspace = await findWorkspaceById(workspace.id)
    }
    return workspace!
  }

  // Create new workspace
  workspace = await createWorkspace({
    orgId: opts.orgId,
    name: workspaceName,
    repo: opts.repo,
    workspacePath: opts.workspacePath,
    environment: "preview",
    prNumber: opts.prNumber,
    branch: opts.branch,
    status: "active",
  })

  logger.info("Preview workspace created", {
    workspaceId: workspace.id,
    workspaceName,
    prNumber: opts.prNumber,
  })

  return workspace
}

/**
 * Find or create a TFC workspace for a named environment (non-preview).
 * Used for branches that trigger named environments (e.g., main → production).
 */
export async function ensureNamedWorkspace(opts: {
  orgId: string
  orgSlug: string
  repo: string
  environment: string
  branch: string
  workspacePath: string
}): Promise<Workspace> {
  const { buildWorkspaceName, createWorkspace } = await import("../db/queries/workspaces.ts")

  const workspaceName = buildWorkspaceName(opts.repo, opts.environment, opts.branch, opts.workspacePath)

  // Check if workspace already exists
  let workspace = await findWorkspaceByName(opts.orgId, workspaceName)
  if (workspace) {
    return workspace
  }

  // Create new workspace - environment is the named environment from yaffle.toml
  workspace = await createWorkspace({
    orgId: opts.orgId,
    name: workspaceName,
    repo: opts.repo,
    workspacePath: opts.workspacePath,
    environment: opts.environment,
    prNumber: null,
    branch: opts.branch,
    status: "active",
  })

  logger.info("Named workspace created", {
    workspaceId: workspace.id,
    workspaceName,
    environment: opts.environment,
    branch: opts.branch,
  })

  return workspace
}

/**
 * Get all workspaces for a PR that need to be archived.
 */
export async function getWorkspacesToArchive(
  orgId: string,
  repo: string,
  prNumber: number,
): Promise<Workspace[]> {
  const workspaces = await findWorkspacesByPr(orgId, repo, prNumber)
  // Filter to only active or destroying workspaces (not already archived)
  return workspaces.filter((ws) => ws.status !== "archived")
}
