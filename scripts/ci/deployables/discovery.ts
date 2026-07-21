import { glob } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { DiscoveredDeployable, DeployableDefinition } from "./types"
import { importMetaDir } from "../../lib/module"

const REPO_ROOT = resolve(importMetaDir(import.meta), "../../..")
const DEPLOYABLE_GLOB = "apps/**/*.yaffle.deployable.ts"

let cachedDeployables: Promise<DiscoveredDeployable[]> | null = null

function toArray(exportsValue: unknown, descriptorPath: string): DeployableDefinition[] {
  if (Array.isArray(exportsValue)) {
    return exportsValue as DeployableDefinition[]
  }

  if (exportsValue && typeof exportsValue === "object") {
    return [exportsValue as DeployableDefinition]
  }

  throw new Error(`Deployable descriptor ${descriptorPath} did not export a deployable definition`)
}

function validateDeployable(definition: DiscoveredDeployable): void {
  if (!definition.name.trim()) {
    throw new Error(`Deployable descriptor ${definition.descriptorPath} is missing a name`)
  }

  if (definition.supports.environmentKinds.length === 0) {
    throw new Error(`Deployable ${definition.name} must support at least one environment kind`)
  }

  if (definition.workspaces.length === 0) {
    throw new Error(`Deployable ${definition.name} must declare at least one workspace`)
  }

  if (definition.watchedPaths.length === 0) {
    throw new Error(`Deployable ${definition.name} must declare at least one watched path`)
  }
}

async function loadDescriptorModule(relativePath: string): Promise<DiscoveredDeployable[]> {
  const absolutePath = resolve(REPO_ROOT, relativePath)
  const module = await import(pathToFileURL(absolutePath).href)
  const exported = module.default ?? module.deployable ?? module.deployables
  const definitions = toArray(exported, relativePath)

  return definitions.map((definition) => {
    const discovered: DiscoveredDeployable = {
      ...definition,
      descriptorPath: relativePath,
    }
    validateDeployable(discovered)
    return discovered
  })
}

async function discoverDeployablesUncached(): Promise<DiscoveredDeployable[]> {
  const files: string[] = []
  for await (const filePath of glob(DEPLOYABLE_GLOB, { cwd: REPO_ROOT })) {
    files.push(filePath)
  }

  const discovered = (
    await Promise.all(files.sort().map((filePath) => loadDescriptorModule(filePath)))
  )
    .flat()
    .sort((a, b) => a.name.localeCompare(b.name))

  const seen = new Set<string>()
  for (const deployable of discovered) {
    if (seen.has(deployable.name)) {
      throw new Error(`Duplicate deployable name discovered: ${deployable.name}`)
    }
    seen.add(deployable.name)
  }

  return discovered
}

export async function discoverDeployables(): Promise<DiscoveredDeployable[]> {
  cachedDeployables ??= discoverDeployablesUncached()
  return cachedDeployables
}

export function resetDeployableDiscoveryCache(): void {
  cachedDeployables = null
}
