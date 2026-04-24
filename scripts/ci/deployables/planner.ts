import type { EnvironmentKind } from "../types"
import type { DeployablePlanEntry } from "../types"

import type { DiscoveredDeployable } from "./types"

export interface PlanDeployablesOptions {
  deployables: DiscoveredDeployable[]
  environmentKind: EnvironmentKind
  changedFiles: string[] | null
  requestedDeployables?: string[]
}

export interface DeployablePlan {
  entries: DeployablePlanEntry[]
  selected: DiscoveredDeployable[]
}

function matchesPath(filePath: string, watchedPath: string): boolean {
  if (watchedPath.endsWith("/")) {
    return filePath.startsWith(watchedPath)
  }

  return filePath === watchedPath
}

function touchedByChanges(deployable: DiscoveredDeployable, changedFiles: string[]): boolean {
  return changedFiles.some((filePath) =>
    deployable.watchedPaths.some((watchedPath) => matchesPath(filePath, watchedPath))
  )
}

export function planDeployables(options: PlanDeployablesOptions): DeployablePlan {
  const requested = new Set(options.requestedDeployables ?? [])
  const deployableByName = new Map(options.deployables.map((deployable) => [deployable.name, deployable]))

  for (const name of requested) {
    if (!deployableByName.has(name)) {
      throw new Error(`Unknown deployable: ${name}`)
    }
  }

  const entries: DeployablePlanEntry[] = []
  const selected: DiscoveredDeployable[] = []

  for (const deployable of options.deployables) {
    const supportsTarget = deployable.supports.environmentKinds.includes(options.environmentKind)
    const entry: DeployablePlanEntry = {
      name: deployable.name,
      status: "unchanged",
      reasons: [],
      supportedEnvironmentKinds: [...deployable.supports.environmentKinds],
    }

    if (requested.size > 0 && !requested.has(deployable.name)) {
      entry.status = "not_requested"
      entry.reasons.push("not explicitly requested")
      entries.push(entry)
      continue
    }

    if (requested.has(deployable.name) && !supportsTarget) {
      throw new Error(
        `Deployable ${deployable.name} does not support ${options.environmentKind} environments`,
      )
    }

    if (!supportsTarget) {
      if (options.changedFiles && touchedByChanges(deployable, options.changedFiles)) {
        entry.status = "unsupported_for_target"
        entry.reasons.push(`changed, but only supports ${deployable.supports.environmentKinds.join(", ")}`)
      } else {
        entry.status = "not_requested"
        entry.reasons.push(`does not support ${options.environmentKind} environments`)
      }

      entries.push(entry)
      continue
    }

    if (requested.has(deployable.name) || options.changedFiles === null) {
      entry.status = "selected"
      entry.reasons.push(requested.has(deployable.name) ? "explicitly requested" : "selected for full convergence")
      selected.push(deployable)
      entries.push(entry)
      continue
    }

    if (touchedByChanges(deployable, options.changedFiles)) {
      entry.status = "selected"
      entry.reasons.push("matched changed files")
      selected.push(deployable)
    } else {
      entry.status = "unchanged"
      entry.reasons.push("no matching changed files")
    }

    entries.push(entry)
  }

  return { entries, selected }
}
