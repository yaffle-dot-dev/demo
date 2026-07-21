import { resolve } from "node:path"

import {
  DependencyGraph,
  buildGraphFromInferred,
  scanAllWorkspaceDependencies,
} from "../../../packages/shared/src"
import { importMetaDir } from "../../lib/module"

import { loadYaffleConfig } from "../config"

import type { DiscoveredDeployable } from "./types"

const REPO_ROOT = resolve(importMetaDir(import.meta), "../../..")

export interface DeployableExecutionNode {
  deployable: DiscoveredDeployable
  dependencies: string[]
}

export function computeDeployableDependencies(
  deployables: DiscoveredDeployable[],
  workspaceGraph: DependencyGraph,
): DeployableExecutionNode[] {
  const owners = new Map<string, Set<string>>()

  for (const deployable of deployables) {
    for (const workspace of deployable.workspaces) {
      let names = owners.get(workspace)
      if (!names) {
        names = new Set()
        owners.set(workspace, names)
      }
      names.add(deployable.name)
    }
  }

  return deployables.map((deployable) => {
    const dependencies = new Set<string>()

    for (const workspace of deployable.workspaces) {
      for (const dependencyWorkspace of workspaceGraph.getDependencies(workspace)) {
        for (const owner of owners.get(dependencyWorkspace) ?? []) {
          if (owner !== deployable.name) {
            dependencies.add(owner)
          }
        }
      }
    }

    return {
      deployable,
      dependencies: Array.from(dependencies).sort(),
    }
  })
}

export function getDeployableExecutionOrder(nodes: DeployableExecutionNode[]): string[] {
  const remaining = new Map(nodes.map((node) => [node.deployable.name, new Set(node.dependencies)]))
  const order: string[] = []

  while (remaining.size > 0) {
    const ready = Array.from(remaining.entries())
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort()

    if (ready.length === 0) {
      throw new Error(
        `Deployable execution graph contains a cycle: ${Array.from(remaining.keys()).join(", ")}`,
      )
    }

    for (const name of ready) {
      order.push(name)
      remaining.delete(name)

      for (const dependencies of remaining.values()) {
        dependencies.delete(name)
      }
    }
  }

  return order
}

export async function buildDeployableExecutionGraph(
  deployables: DiscoveredDeployable[],
): Promise<DeployableExecutionNode[]> {
  const config = await loadYaffleConfig()
  const workspacePaths = config.workspaces.map((workspace) => workspace.path)
  const inferred = await scanAllWorkspaceDependencies(REPO_ROOT, workspacePaths)
  const workspaceGraph = buildGraphFromInferred(inferred.workspaces, inferred.edges)

  return computeDeployableDependencies(deployables, workspaceGraph).filter((node) =>
    deployableByNameHas(deployables, node.deployable.name),
  )
}

function deployableByNameHas(deployables: DiscoveredDeployable[], name: string): boolean {
  return deployables.some((deployable) => deployable.name === name)
}
