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

  const match = value.match(/^pr-(\d+)$/i)
  if (!match) {
    return null
  }

  return {
    prNumber: parseInt(match[1], 10),
  }
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
 * 2. If preview context, check if a preview workspace exists for this PR
 * 3. If preview workspace exists, use it; otherwise fall back to production
 *
 * This implements "auto" preview resolution. The "never" and "always" modes
 * will be added when config parsing is implemented (YAF-41).
 */
export async function resolveModule(
  options: ResolveModuleOptions,
): Promise<ResolvedModule | null> {
  const { orgId, repo, workspacePath, serial, previewContext } = options

  let workspace: Workspace | undefined
  let isPreview = false

  // Try preview workspace first if we have preview context
  if (previewContext) {
    workspace = await findPreviewWorkspace(orgId, repo, workspacePath, previewContext.prNumber)
    if (workspace) {
      isPreview = true
      logger.debug("Resolved to preview workspace", {
        repo,
        workspacePath,
        prNumber: previewContext.prNumber,
        workspaceId: workspace.id,
      })
    }
  }

  // Fall back to non-preview workspace (e.g. main branch) if no preview workspace found
  if (!workspace) {
    workspace = await findNonPreviewWorkspace(orgId, repo, workspacePath)
    if (workspace) {
      logger.debug("Resolved to non-preview workspace", {
        repo,
        workspacePath,
        workspaceId: workspace.id,
        environment: workspace.environment,
        hadPreviewContext: !!previewContext,
      })
    }
  }

  if (!workspace) {
    return null
  }

  // Get the state version
  let stateVersion: StateVersion | undefined

  if (serial === "latest") {
    stateVersion = await getCurrentStateVersion(workspace.id)
  } else {
    stateVersion = await findStateVersionBySerial(workspace.id, serial)
  }

  if (!stateVersion) {
    return null
  }

  // Must be finalized
  if (stateVersion.status !== "finalized") {
    return null
  }

  return {
    workspace,
    stateVersion,
    isPreview,
  }
}
