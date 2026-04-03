/**
 * Module Dependency Scanner
 *
 * Scans Terraform files in workspace directories to infer dependencies
 * between workspaces based on Yaffle registry module sources.
 *
 * Module sources follow the pattern:
 *   source = "HOST[:PORT]/ORG--REPO/WORKSPACE--PATH/yaffle"
 *
 * Where:
 * - ORG--REPO is the namespace (e.g., `yaffle-dot-dev--yaffle`)
 * - WORKSPACE--PATH uses `--` as path separator (e.g., `apps--web--infra`
 *   maps to workspace path `apps/web/infra`)
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Result of scanning a single workspace for dependencies.
 */
export interface WorkspaceDependencies {
  /** The workspace path that was scanned */
  workspacePath: string
  /** Paths of workspaces this one depends on */
  dependsOn: string[]
}

/**
 * Full dependency graph inferred from Terraform files.
 */
export interface InferredDependencyGraph {
  /** All workspace paths in the graph */
  workspaces: string[]
  /** Edges as [source, target] tuples (source depends on target) */
  edges: [string, string][]
}

/**
 * Pattern to match Terraform module source values.
 */
const MODULE_SOURCE_PATTERN = /source\s*=\s*"([^"]+)"/g

const DEFAULT_ALLOWED_MODULE_HOSTS = ["yaffle.dev", "yaffle.local", ".ts.net"]

function getAllowedModuleHosts(allowedHostsOverride?: string[]): string[] {
  if (allowedHostsOverride) {
    return allowedHostsOverride
  }

  const fromEnv = process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS
  if (!fromEnv) {
    return DEFAULT_ALLOWED_MODULE_HOSTS
  }

  const parsed = fromEnv
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)

  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_MODULE_HOSTS
}

function isAllowedModuleHost(host: string, allowedHosts: string[]): boolean {
  const normalizedHost = host.toLowerCase()

  return allowedHosts.some((allowedHost) => {
    if (allowedHost.startsWith(".")) {
      const suffix = allowedHost.slice(1)
      return normalizedHost === suffix || normalizedHost.endsWith(allowedHost)
    }

    return normalizedHost === allowedHost
  })
}

function parseYaffleModuleWorkspacePath(source: string, allowedHosts: string[]): string | null {
  if (source.includes("://")) {
    return null
  }

  const parts = source.split("/")
  if (parts.length !== 4) {
    return null
  }

  const [hostWithOptionalPort, namespace, moduleName, provider] = parts
  if (provider !== "yaffle") {
    return null
  }

  if (!namespace.includes("--")) {
    return null
  }

  const host = hostWithOptionalPort.split(":")[0]
  if (!isAllowedModuleHost(host, allowedHosts)) {
    return null
  }

  return moduleNameToWorkspacePath(moduleName)
}

/**
 * Convert a module name back to a workspace path.
 *
 * @example
 * moduleNameToWorkspacePath("apps--web--infra") // => "apps/web/infra"
 * moduleNameToWorkspacePath("infra--shared") // => "infra/shared"
 */
export function moduleNameToWorkspacePath(moduleName: string): string {
  return moduleName.replace(/--/g, "/")
}

/**
 * Convert a workspace path to a module name.
 *
 * @example
 * workspacePathToModuleName("apps/web/infra") // => "apps--web--infra"
 * workspacePathToModuleName("infra/shared") // => "infra--shared"
 */
export function workspacePathToModuleName(workspacePath: string): string {
  return workspacePath.replace(/\//g, "--")
}

/**
 * Extract Yaffle module dependencies from Terraform file content.
 *
 * @param content - The content of a .tf file
 * @param allowedHosts - Optional override for allowed module hosts
 * @returns Array of workspace paths that are referenced as dependencies
 */
export function extractDependenciesFromContent(content: string, allowedHosts?: string[]): string[] {
  const dependencies: string[] = []
  const hosts = getAllowedModuleHosts(allowedHosts)
  let match: RegExpExecArray | null

  // Reset regex state
  MODULE_SOURCE_PATTERN.lastIndex = 0

  while ((match = MODULE_SOURCE_PATTERN.exec(content)) !== null) {
    const source = match[1]
    const workspacePath = parseYaffleModuleWorkspacePath(source, hosts)
    if (!workspacePath) {
      continue
    }

    dependencies.push(workspacePath)
  }

  return dependencies
}

/**
 * Recursively find all .tf files in a directory.
 */
async function findTerraformFiles(dir: string): Promise<string[]> {
  const files: string[] = []

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      // Skip hidden directories and common non-TF directories
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue
      }

      if (entry.isDirectory()) {
        const subFiles = await findTerraformFiles(fullPath)
        files.push(...subFiles)
      } else if (entry.isFile() && entry.name.endsWith(".tf")) {
        files.push(fullPath)
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable - that's OK
  }

  return files
}

/**
 * Scan a single workspace directory for dependencies.
 *
 * @param repoDir - Absolute path to the repo root
 * @param workspacePath - Relative path to the workspace (e.g., "apps/web/infra")
 * @param knownWorkspaces - Set of valid workspace paths to filter against
 * @returns Dependencies found for this workspace
 */
export async function scanWorkspace(
  repoDir: string,
  workspacePath: string,
  knownWorkspaces: Set<string>,
): Promise<WorkspaceDependencies> {
  const workspaceDir = join(repoDir, workspacePath)
  const allDependencies: string[] = []

  // Check if workspace directory exists
  try {
    const stats = await stat(workspaceDir)
    if (!stats.isDirectory()) {
      return { workspacePath, dependsOn: [] }
    }
  } catch {
    return { workspacePath, dependsOn: [] }
  }

  // Find all .tf files
  const tfFiles = await findTerraformFiles(workspaceDir)

  // Extract dependencies from each file
  for (const tfFile of tfFiles) {
    try {
      const content = await readFile(tfFile, "utf-8")
      const deps = extractDependenciesFromContent(content)

      for (const dep of deps) {
        // Only include dependencies that are valid workspace paths
        if (knownWorkspaces.has(dep) && dep !== workspacePath) {
          allDependencies.push(dep)
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Deduplicate
  const uniqueDeps = Array.from(new Set(allDependencies))

  return {
    workspacePath,
    dependsOn: uniqueDeps,
  }
}

/**
 * Scan all workspaces in a repo for their dependencies.
 *
 * @param repoDir - Absolute path to the repo root
 * @param workspacePaths - List of workspace paths from config
 * @returns Full dependency graph
 */
export async function scanAllWorkspaceDependencies(
  repoDir: string,
  workspacePaths: string[],
): Promise<InferredDependencyGraph> {
  const knownWorkspaces = new Set(workspacePaths)
  const edges: [string, string][] = []

  // Scan each workspace
  for (const wsPath of workspacePaths) {
    const result = await scanWorkspace(repoDir, wsPath, knownWorkspaces)

    for (const dep of result.dependsOn) {
      edges.push([wsPath, dep])
    }
  }

  return {
    workspaces: workspacePaths,
    edges,
  }
}
