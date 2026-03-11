/**
 * Workspace dependency graph with cycle detection.
 *
 * This module provides a DAG (Directed Acyclic Graph) implementation
 * for tracking workspace dependencies.
 */

/**
 * Dependency relationship between workspaces.
 */
export interface WorkspaceDependency {
  /** Workspace path that depends on another */
  source: string
  /** Workspace path being depended on */
  target: string
  /** Preview resolution mode */
  preview: "never" | "auto" | "always"
}

/**
 * Consumer allowlist for a workspace.
 */
export interface WorkspaceConsumers {
  /** Workspace path */
  path: string
  /** Glob patterns of workspaces allowed to consume this one */
  patterns: string[]
}

/**
 * Result of a cycle detection check.
 */
export interface CycleCheckResult {
  hasCycle: boolean
  /** The path forming the cycle, if one exists */
  cyclePath?: string[]
}

/**
 * Dependency graph for workspace relationships.
 */
export class DependencyGraph {
  /** Map from workspace path to its dependencies */
  private dependencies = new Map<string, Set<string>>()
  /** Map from workspace path to workspaces that depend on it */
  private dependents = new Map<string, Set<string>>()
  /** Dependency metadata (preview mode) */
  private metadata = new Map<string, Map<string, WorkspaceDependency>>()
  /** Consumer allowlists */
  private consumers = new Map<string, string[]>()

  /**
   * Add a dependency relationship.
   */
  addDependency(dep: WorkspaceDependency): void {
    // Add to dependencies map
    if (!this.dependencies.has(dep.source)) {
      this.dependencies.set(dep.source, new Set())
    }
    this.dependencies.get(dep.source)!.add(dep.target)

    // Add to dependents map (reverse index)
    if (!this.dependents.has(dep.target)) {
      this.dependents.set(dep.target, new Set())
    }
    this.dependents.get(dep.target)!.add(dep.source)

    // Store metadata
    if (!this.metadata.has(dep.source)) {
      this.metadata.set(dep.source, new Map())
    }
    this.metadata.get(dep.source)!.set(dep.target, dep)
  }

  /**
   * Set consumer allowlist for a workspace.
   */
  setConsumers(path: string, patterns: string[]): void {
    this.consumers.set(path, patterns)
  }

  /**
   * Add an isolated node (workspace with no dependencies).
   * Used to ensure all workspaces appear in topological order.
   */
  addIsolatedNode(path: string): void {
    if (!this.dependencies.has(path)) {
      this.dependencies.set(path, new Set())
    }
  }

  /**
   * Get all nodes in the graph.
   */
  getAllNodes(): string[] {
    const nodes = new Set<string>()
    for (const [source, targets] of Array.from(this.dependencies)) {
      nodes.add(source)
      for (const target of Array.from(targets)) {
        nodes.add(target)
      }
    }
    for (const [target] of Array.from(this.dependents)) {
      nodes.add(target)
    }
    return Array.from(nodes)
  }

  /**
   * Get direct dependencies of a workspace.
   */
  getDependencies(path: string): string[] {
    return Array.from(this.dependencies.get(path) ?? [])
  }

  /**
   * Get workspaces that directly depend on this one.
   */
  getDependents(path: string): string[] {
    return Array.from(this.dependents.get(path) ?? [])
  }

  /**
   * Get dependency metadata (preview mode, etc.).
   */
  getDependencyMetadata(source: string, target: string): WorkspaceDependency | undefined {
    return this.metadata.get(source)?.get(target)
  }

  /**
   * Get consumer patterns for a workspace.
   */
  getConsumerPatterns(path: string): string[] | undefined {
    return this.consumers.get(path)
  }

  /**
   * Check if a workspace is allowed to consume another.
   *
   * Rules:
   * - If no consumers defined, anyone can use (MVP default)
   * - If consumers is empty array, no one can use (private)
   * - Otherwise, consumer must match one of the patterns
   */
  isConsumerAllowed(consumer: string, producer: string): boolean {
    const patterns = this.consumers.get(producer)

    // No consumers defined = anyone can use
    if (patterns === undefined) {
      return true
    }

    // Empty consumers = no one can use
    if (patterns.length === 0) {
      return false
    }

    // Check if consumer matches any pattern
    return patterns.some((pattern) => matchGlobPattern(pattern, consumer))
  }

  /**
   * Get all transitive dependencies of a workspace.
   */
  getTransitiveDependencies(path: string): string[] {
    const visited = new Set<string>()
    const result: string[] = []

    const visit = (current: string) => {
      for (const dep of this.getDependencies(current)) {
        if (!visited.has(dep)) {
          visited.add(dep)
          result.push(dep)
          visit(dep)
        }
      }
    }

    visit(path)
    return result
  }

  /**
   * Get all transitive dependents (workspaces affected by changes).
   */
  getTransitiveDependents(path: string): string[] {
    const visited = new Set<string>()
    const result: string[] = []

    const visit = (current: string) => {
      for (const dep of this.getDependents(current)) {
        if (!visited.has(dep)) {
          visited.add(dep)
          result.push(dep)
          visit(dep)
        }
      }
    }

    visit(path)
    return result
  }

  /**
   * Check for cycles in the dependency graph.
   * Returns the first cycle found, if any.
   */
  detectCycle(): CycleCheckResult {
    // Color states: 0 = not visited, 1 = in progress, 2 = complete
    const WHITE = 0

    const color = new Map<string, number>()
    const parent = new Map<string, string>()

    // Initialize all nodes as white
    for (const node of Array.from(this.dependencies.keys())) {
      color.set(node, WHITE)
    }

    // Also add nodes that are only targets (no dependencies of their own)
    for (const targets of Array.from(this.dependencies.values())) {
      for (const target of targets) {
        if (!color.has(target)) {
          color.set(target, WHITE)
        }
      }
    }

    // DFS from each unvisited node
    for (const start of Array.from(color.keys())) {
      if (color.get(start) === WHITE) {
        const cycle = this.dfsDetectCycle(start, color, parent)
        if (cycle) {
          return { hasCycle: true, cyclePath: cycle }
        }
      }
    }

    return { hasCycle: false }
  }

  private dfsDetectCycle(
    node: string,
    color: Map<string, number>,
    parent: Map<string, string>,
  ): string[] | null {
    const WHITE = 0
    const GRAY = 1
    const BLACK = 2

    color.set(node, GRAY)

    for (const neighbor of this.getDependencies(node)) {
      if (color.get(neighbor) === GRAY) {
        // Found a cycle - reconstruct path
        const cycle = [neighbor, node]
        let current = node
        while (parent.has(current) && parent.get(current) !== neighbor) {
          current = parent.get(current)!
          cycle.push(current)
        }
        return cycle.reverse()
      }

      if (color.get(neighbor) === WHITE) {
        parent.set(neighbor, node)
        const cycle = this.dfsDetectCycle(neighbor, color, parent)
        if (cycle) {
          return cycle
        }
      }
    }

    color.set(node, BLACK)
    return null
  }

  /**
   * Get topological order for plan/apply execution.
   * Returns null if there's a cycle.
   */
  getTopologicalOrder(): string[] | null {
    const result: string[] = []
    const visited = new Set<string>()
    const temp = new Set<string>() // For cycle detection

    const visit = (node: string): boolean => {
      if (temp.has(node)) {
        // Cycle detected
        return false
      }
      if (visited.has(node)) {
        return true
      }

      temp.add(node)

      // Visit dependencies first
      for (const dep of this.getDependencies(node)) {
        if (!visit(dep)) {
          return false
        }
      }

      temp.delete(node)
      visited.add(node)
      result.push(node)
      return true
    }

    // Visit all nodes
    const allNodes = new Set<string>()
    for (const [source, targets] of Array.from(this.dependencies)) {
      allNodes.add(source)
      for (const target of Array.from(targets)) {
        allNodes.add(target)
      }
    }

    for (const node of Array.from(allNodes)) {
      if (!visited.has(node)) {
        if (!visit(node)) {
          return null
        }
      }
    }

    return result
  }

  /**
   * Export the graph as a serializable object.
   */
  toJSON(): {
    dependencies: Array<{ source: string; target: string; preview: string }>
    consumers: Array<{ path: string; patterns: string[] }>
  } {
    const dependencies: Array<{ source: string; target: string; preview: string }> = []

    for (const [, meta] of Array.from(this.metadata)) {
      for (const [, dep] of Array.from(meta)) {
        dependencies.push({
          source: dep.source,
          target: dep.target,
          preview: dep.preview,
        })
      }
    }

    const consumers: Array<{ path: string; patterns: string[] }> = []
    for (const [path, patterns] of Array.from(this.consumers)) {
      consumers.push({ path, patterns })
    }

    return { dependencies, consumers }
  }

  /**
   * Export to minimal serializable format for UI/storage.
   * This is the format stored in run_groups.dependency_graph.
   */
  toSerializable(): SerializableDependencyGraph {
    const workspaces = this.getAllNodes()
    const edges: [string, string][] = []

    for (const [source, targets] of Array.from(this.dependencies)) {
      for (const target of Array.from(targets)) {
        edges.push([source, target])
      }
    }

    return { workspaces, edges }
  }

  /**
   * Create a graph from the minimal serializable format.
   */
  static fromSerializable(data: SerializableDependencyGraph): DependencyGraph {
    return buildGraphFromInferred(data.workspaces, data.edges)
  }

  /**
   * Create a graph from serialized data.
   */
  static fromJSON(data: {
    dependencies: Array<{ source: string; target: string; preview: string }>
    consumers: Array<{ path: string; patterns: string[] }>
  }): DependencyGraph {
    const graph = new DependencyGraph()

    for (const dep of data.dependencies) {
      graph.addDependency({
        source: dep.source,
        target: dep.target,
        preview: dep.preview as "never" | "auto" | "always",
      })
    }

    for (const { path, patterns } of data.consumers) {
      graph.setConsumers(path, patterns)
    }

    return graph
  }
}

/**
 * Serializable dependency graph for API responses and storage.
 * This is the minimal representation needed for UI rendering.
 */
export interface SerializableDependencyGraph {
  /** All workspace paths in the graph */
  workspaces: string[]
  /** Edges as [source, target] tuples (source depends on target) */
  edges: [string, string][]
}

/**
 * Build a DependencyGraph from inferred dependencies.
 *
 * This is used by the module dependency scanner to create a graph
 * from Terraform module source analysis.
 *
 * @param workspaces - All workspace paths
 * @param edges - Dependency edges as [source, target] tuples
 * @returns A populated DependencyGraph
 */
export function buildGraphFromInferred(
  workspaces: string[],
  edges: [string, string][],
): DependencyGraph {
  const graph = new DependencyGraph()

  for (const [source, target] of edges) {
    graph.addDependency({
      source,
      target,
      preview: "auto", // Default for inferred dependencies
    })
  }

  // Ensure all workspaces are represented in the graph
  // (even those with no dependencies)
  for (const ws of workspaces) {
    if (!graph.getDependencies(ws).length && !graph.getDependents(ws).length) {
      // Add as isolated node by adding empty dependency set
      graph.addIsolatedNode(ws)
    }
  }

  return graph
}

/**
 * Match a simple glob pattern against a path.
 *
 * Supports:
 * - * matches any single path segment
 * - ** matches any number of path segments
 */
export function matchGlobPattern(pattern: string, path: string): boolean {
  // Escape special regex characters except * and **
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]+")
    .replace(/{{GLOBSTAR}}/g, ".*")

  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(path)
}
