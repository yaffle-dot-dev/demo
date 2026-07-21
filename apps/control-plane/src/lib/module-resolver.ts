import { environmentName, type EnvironmentName } from "@yaffle/shared"

import {
  findNamedWorkspace,
  findTransientWorkspace,
  type Workspace,
} from "../db/queries/workspaces.ts"
import {
  getCurrentStateVersion,
  findStateVersionBySerial,
  type StateVersion,
} from "../db/queries/state-versions.ts"
import { logger } from "./telemetry.ts"

/**
 * Source-neutral transient environment context for module resolution.
 */
export interface TransientEnvironmentContext {
  environmentName: EnvironmentName
}

/**
 * Parse a transient environment identity from a query parameter value.
 */
export function parseTransientEnvironmentContext(
  value: string | null,
): TransientEnvironmentContext | null {
  if (!value?.trim()) {
    return null
  }

  return { environmentName: environmentName(value) }
}

/**
 * Result of resolving a module to a workspace and state version.
 */
export interface ResolvedModule {
  workspace: Workspace
  stateVersion: StateVersion
  isTransient: boolean
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
  /** Transient environment identity, if resolving in a transient environment */
  transientEnvironment: TransientEnvironmentContext | null
}

/**
 * Resolve a module to a workspace and state version.
 *
 * Resolution algorithm:
 * 1. If no transient environment is requested, resolve to a named environment
 * 2. Prefer a matching transient workspace only when it has a usable
 *    finalized state version for the requested serial
 * 3. Fall back to a named workspace when the transient workspace is
 *    missing or has no finalized state to serve
 */
export async function resolveModule(options: ResolveModuleOptions): Promise<ResolvedModule | null> {
  const { orgId, repo, workspacePath, serial, transientEnvironment } = options

  async function findUsableStateVersion(workspaceId: string): Promise<StateVersion | undefined> {
    const stateVersion =
      serial === "latest"
        ? await getCurrentStateVersion(workspaceId)
        : await findStateVersionBySerial(workspaceId, serial)

    if (!stateVersion || stateVersion.status !== "finalized") {
      return undefined
    }

    return stateVersion
  }

  if (transientEnvironment) {
    const transientWorkspace = await findTransientWorkspace(
      orgId,
      repo,
      workspacePath,
      transientEnvironment.environmentName,
    )
    if (transientWorkspace) {
      const transientStateVersion = await findUsableStateVersion(transientWorkspace.id)
      if (transientStateVersion) {
        logger.debug("Resolved to transient workspace", {
          repo,
          workspacePath,
          environmentName: transientEnvironment.environmentName,
          workspaceId: transientWorkspace.id,
          stateVersionId: transientStateVersion.id,
          serial: transientStateVersion.serial,
        })

        return {
          workspace: transientWorkspace,
          stateVersion: transientStateVersion,
          isTransient: true,
        }
      }

      logger.info(
        "Transient workspace has no finalized state version, falling back to named workspace",
        {
          repo,
          workspacePath,
          environmentName: transientEnvironment.environmentName,
          workspaceId: transientWorkspace.id,
          requestedSerial: serial,
        },
      )
    }
  }

  const workspace = await findNamedWorkspace(orgId, repo, workspacePath)
  if (!workspace) {
    return null
  }

  const stateVersion = await findUsableStateVersion(workspace.id)
  if (!stateVersion) {
    return null
  }

  logger.debug("Resolved to named workspace", {
    repo,
    workspacePath,
    workspaceId: workspace.id,
    stateVersionId: stateVersion.id,
    serial: stateVersion.serial,
    environmentName: workspace.environmentName,
    hadTransientEnvironment: !!transientEnvironment,
  })

  return {
    workspace,
    stateVersion,
    isTransient: false,
  }
}
