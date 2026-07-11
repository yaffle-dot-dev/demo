import {
  findNonPreviewWorkspace,
  findPreviewWorkspace,
  type Workspace,
} from "../db/queries/workspaces.ts"
import {
  getCurrentStateVersion,
  findStateVersionBySerial,
  type StateVersion,
} from "../db/queries/state-versions.ts"
import { logger } from "./telemetry.ts"

/**
 * Preview context for module resolution.
 * Passed via ?preview=pr-{n} query parameter.
 */
export interface PreviewContext {
  /** PR number for the preview */
  prNumber: number
}

/**
 * Parse preview context from a query parameter value.
 * Accepts "pr-42" format.
 */
export function parsePreviewContext(value: string | null): PreviewContext | null {
  if (!value) {
    return null
  }

  const match = value.match(/^pr-([1-9]\d*)$/)
  if (!match) {
    return null
  }

  const prNumber = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(prNumber) ? { prNumber } : null
}

/**
 * Result of resolving a module to a workspace and state version.
 */
export interface ResolvedModule {
  workspace: Workspace
  stateVersion: StateVersion
  /** Whether this resolved to a preview workspace */
  isPreview: boolean
}

/**
 * Options for module resolution.
 */
export interface ResolveModuleOptions {
  /** Organization ID */
  orgId: string
  /** Repository name (e.g., "yaffle", "infrastructure") */
  repo: string
  /** Workspace path (e.g., "core-infrastructure/vpc") */
  workspacePath: string
  /** State version serial, or "latest" for current */
  serial: number | "latest"
  /** Preview context, if resolving in a preview */
  previewContext: PreviewContext | null
}

/**
 * Resolve a module to a workspace and state version.
 *
 * Resolution algorithm:
 * 1. If no preview context, resolve to production
 * 2. If preview context, prefer a preview workspace only when it has a usable
 *    finalized state version for the requested serial
 * 3. Fall back to a non-preview workspace when the preview workspace is
 *    missing or has no finalized state to serve
 *
 * This implements "auto" preview resolution. The "never" and "always" modes
 * will be added when config parsing is implemented (YAF-41).
 */
export async function resolveModule(
  options: ResolveModuleOptions,
): Promise<ResolvedModule | null> {
  const { orgId, repo, workspacePath, serial, previewContext } = options

  async function findUsableStateVersion(workspaceId: string): Promise<StateVersion | undefined> {
    const stateVersion = serial === "latest"
      ? await getCurrentStateVersion(workspaceId)
      : await findStateVersionBySerial(workspaceId, serial)

    if (!stateVersion || stateVersion.status !== "finalized") {
      return undefined
    }

    return stateVersion
  }

  // Try preview workspace first if we have preview context
  if (previewContext) {
    const previewWorkspace = await findPreviewWorkspace(orgId, repo, workspacePath, previewContext.prNumber)
    if (previewWorkspace) {
      const previewStateVersion = await findUsableStateVersion(previewWorkspace.id)
      if (previewStateVersion) {
        logger.debug("Resolved to preview workspace", {
          repo,
          workspacePath,
          prNumber: previewContext.prNumber,
          workspaceId: previewWorkspace.id,
          stateVersionId: previewStateVersion.id,
          serial: previewStateVersion.serial,
        })

        return {
          workspace: previewWorkspace,
          stateVersion: previewStateVersion,
          isPreview: true,
        }
      }

      logger.info("Preview workspace has no finalized state version, falling back to non-preview workspace", {
        repo,
        workspacePath,
        prNumber: previewContext.prNumber,
        workspaceId: previewWorkspace.id,
        requestedSerial: serial,
      })
    }
  }

  // Fall back to non-preview workspace (e.g. main branch) if no usable preview was found
  const workspace = await findNonPreviewWorkspace(orgId, repo, workspacePath)
  if (!workspace) {
    return null
  }

  const stateVersion = await findUsableStateVersion(workspace.id)
  if (!stateVersion) {
    return null
  }

  logger.debug("Resolved to non-preview workspace", {
    repo,
    workspacePath,
    workspaceId: workspace.id,
    stateVersionId: stateVersion.id,
    serial: stateVersion.serial,
    environment: workspace.environment,
    hadPreviewContext: !!previewContext,
  })

  return {
    workspace,
    stateVersion,
    isPreview: false,
  }
}
