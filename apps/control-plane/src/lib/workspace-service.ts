import {
  archiveWorkspaceAfterDestroy,
  archiveWorkspace,
  findTransientWorkspaces,
  findWorkspaceById,
  findWorkspaceByIdentity,
  forceUnlockWorkspace,
  markWorkspaceDestroying,
  updateWorkspaceStatus,
  type Workspace,
} from "../db/queries/workspaces.ts"
import { logger } from "./telemetry.ts"

/**
 * Archive a transient workspace.
 *
 * This is called when a PR is closed (merged or not).
 * The actual terraform destroy happens separately in the webhook handler.
 *
 * Flow:
 * 1. Record destroy intent while preserving any existing backend lock
 * 2. Set status to "destroying" without taking a new backend lock
 * 3. The IaC engine acquires the backend lock and runs terraform destroy
 * 4. Set status to "archived" after destroy succeeds
 *
 * If destroy fails, status remains "destroying" so it can be retried or
 * force-archived later.
 */
export async function beginWorkspaceArchive(workspaceId: string): Promise<Workspace | null> {
  const workspace = await findWorkspaceById(workspaceId)
  if (!workspace) {
    logger.warn("Cannot archive workspace: not found", { workspaceId })
    return null
  }

  if (workspace.status === "archived") {
    logger.info("Workspace already archived", { workspaceId })
    return workspace
  }

  const destroying = await markWorkspaceDestroying(workspaceId)
  if (!destroying) {
    logger.warn("Cannot begin workspace archive from current state", {
      workspaceId,
      status: workspace.status,
    })
    return null
  }

  logger.info("Workspace marked for destruction", { workspaceId })

  return destroying
}

/**
 * Complete the archive after successful destroy.
 */
export async function completeWorkspaceArchive(workspaceId: string): Promise<Workspace | null> {
  const archived = await archiveWorkspaceAfterDestroy(workspaceId)
  if (!archived) {
    logger.error("Failed to archive workspace", { workspaceId })
    return null
  }

  logger.info("Workspace archived", { workspaceId })
  return archived
}

/**
 * Mark workspace archive as failed.
 * Leaves the workspace in the destroying state so it can be retried or force-archived.
 */
export async function failWorkspaceArchive(
  workspaceId: string,
  errorMessage: string,
): Promise<void> {
  // Status stays as "destroying" but we log the failure.
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
 * Find or create a TFC workspace for a transient environment.
 */
export async function ensureTransientWorkspace(opts: {
  orgId: string
  orgSlug: string
  repo: string
  environment: string
  workspacePath: string
  ref: string
}): Promise<Workspace> {
  const { buildWorkspaceName, createWorkspace } = await import("../db/queries/workspaces.ts")

  // Extract branch/tag name from full ref for workspace naming
  const refName = opts.ref.replace(/^refs\/(heads|tags)\//, "")
  const workspaceName = buildWorkspaceName(opts.repo, opts.environment, refName, opts.workspacePath)

  // Check if workspace already exists
  let workspace = await findWorkspaceByIdentity(
    opts.orgId,
    opts.repo,
    opts.workspacePath,
    "transient",
    opts.environment,
  )
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
    environmentKind: "transient",
    environmentName: opts.environment,
    ref: opts.ref,
    status: "active",
  })

  logger.info("Transient workspace created", {
    workspaceId: workspace.id,
    workspaceName,
    environmentName: opts.environment,
  })

  return workspace
}

/**
 * Find or create a TFC workspace for a named environment.
 * Used for refs that trigger named environments (e.g., refs/heads/main → production).
 */
export async function ensureNamedWorkspace(opts: {
  orgId: string
  orgSlug: string
  repo: string
  environment: string
  ref: string
  workspacePath: string
}): Promise<Workspace> {
  const { buildWorkspaceName, createWorkspace } = await import("../db/queries/workspaces.ts")

  // Extract branch/tag name from full ref for workspace naming
  const refName = opts.ref.replace(/^refs\/(heads|tags)\//, "")
  const workspaceName = buildWorkspaceName(opts.repo, opts.environment, refName, opts.workspacePath)

  // Check if workspace already exists
  let workspace = await findWorkspaceByIdentity(
    opts.orgId,
    opts.repo,
    opts.workspacePath,
    "named",
    opts.environment,
  )
  if (workspace) {
    return workspace
  }

  // Create new workspace - environment is the named environment from yaffle.toml
  workspace = await createWorkspace({
    orgId: opts.orgId,
    name: workspaceName,
    repo: opts.repo,
    workspacePath: opts.workspacePath,
    environmentKind: "named",
    environmentName: opts.environment,
    ref: opts.ref,
    status: "active",
  })

  logger.info("Named workspace created", {
    workspaceId: workspace.id,
    workspaceName,
    environment: opts.environment,
    ref: opts.ref,
  })

  return workspace
}

/**
 * Get all workspaces for a transient environment that need to be archived.
 */
export async function getTransientWorkspacesToArchive(
  orgId: string,
  repo: string,
  environmentName: string,
): Promise<Workspace[]> {
  const workspaces = await findTransientWorkspaces(orgId, repo, environmentName)
  // Filter to only active or destroying workspaces (not already archived)
  return workspaces.filter((ws) => ws.status !== "archived")
}
