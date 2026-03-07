import { parse as parseYaml } from "yaml"
import { z } from "zod"

import { DependencyGraph, type WorkspaceDependency } from "./dependency-graph.ts"

/**
 * Schema for .yaffle/config.yml workspace dependency configuration.
 */

const DependencyRefSchema = z.union([
  // Simple string: "core-infrastructure/vpc"
  z.string(),
  // Object with explicit settings
  z.object({
    workspace: z.string(),
    preview: z.enum(["never", "auto", "always"]).default("auto"),
  }),
])

const WorkspaceConfigSchema = z.object({
  path: z.string(),
  uses: z.array(DependencyRefSchema).optional(),
  consumers: z.array(z.string()).optional(),
})

const YaffleConfigSchema = z.object({
  workspaces: z.array(WorkspaceConfigSchema).optional(),
})

export type YaffleConfig = z.infer<typeof YaffleConfigSchema>
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>
export type DependencyRef = z.infer<typeof DependencyRefSchema>

/**
 * Parse a .yaffle/config.yml file content.
 */
export function parseYaffleConfig(content: string): YaffleConfig {
  const raw = parseYaml(content)
  return YaffleConfigSchema.parse(raw)
}

/**
 * Normalize a dependency reference to its full form.
 */
function normalizeDependencyRef(ref: DependencyRef): { workspace: string; preview: "never" | "auto" | "always" } {
  if (typeof ref === "string") {
    return { workspace: ref, preview: "auto" }
  }
  return { workspace: ref.workspace, preview: ref.preview }
}

/**
 * Build a dependency graph from a Yaffle config.
 */
export function buildDependencyGraphFromConfig(config: YaffleConfig): DependencyGraph {
  const graph = new DependencyGraph()

  for (const ws of config.workspaces ?? []) {
    // Add dependencies
    if (ws.uses) {
      for (const ref of ws.uses) {
        const { workspace, preview } = normalizeDependencyRef(ref)
        graph.addDependency({
          source: ws.path,
          target: workspace,
          preview,
        })
      }
    }

    // Set consumer allowlist
    if (ws.consumers !== undefined) {
      graph.setConsumers(ws.path, ws.consumers)
    }
  }

  return graph
}

/**
 * Validation result for a Yaffle config.
 */
export interface ConfigValidationResult {
  valid: boolean
  errors: ConfigValidationError[]
}

export interface ConfigValidationError {
  type: "cycle" | "missing_dependency" | "consumer_denied"
  message: string
  details?: {
    source?: string
    target?: string
    cyclePath?: string[]
  }
}

/**
 * Validate a dependency graph.
 *
 * Checks:
 * 1. No cycles in the dependency graph
 * 2. Consumer allowlists are respected
 *
 * Note: Missing dependency check requires access to workspace database,
 * so it's done separately in validateConfigWithWorkspaces().
 */
export function validateDependencyGraph(graph: DependencyGraph): ConfigValidationResult {
  const errors: ConfigValidationError[] = []

  // Check for cycles
  const cycleResult = graph.detectCycle()
  if (cycleResult.hasCycle) {
    errors.push({
      type: "cycle",
      message: `Circular dependency detected: ${cycleResult.cyclePath?.join(" -> ")}`,
      details: { cyclePath: cycleResult.cyclePath },
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Check consumer allowlists for a specific dependency.
 */
export function checkConsumerAllowed(
  graph: DependencyGraph,
  consumer: string,
  producer: string,
): ConfigValidationError | null {
  if (!graph.isConsumerAllowed(consumer, producer)) {
    return {
      type: "consumer_denied",
      message: `Workspace "${consumer}" is not allowed to consume "${producer}"`,
      details: { source: consumer, target: producer },
    }
  }
  return null
}

/**
 * Get all dependencies for a workspace from the config.
 */
export function getWorkspaceDependencies(
  config: YaffleConfig,
  workspacePath: string,
): WorkspaceDependency[] {
  const ws = config.workspaces?.find((w) => w.path === workspacePath)
  if (!ws?.uses) {
    return []
  }

  return ws.uses.map((ref) => {
    const { workspace, preview } = normalizeDependencyRef(ref)
    return {
      source: workspacePath,
      target: workspace,
      preview,
    }
  })
}
