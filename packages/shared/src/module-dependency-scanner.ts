/**
 * Module Dependency Scanner
 *
 * Scans Terraform files in workspace directories to infer dependencies
 * between workspaces based on Yaffle registry module sources.
 *
 * Module sources follow the pattern:
 *   source = "HOST[:PORT]/ORG--REPO/WORKSPACE--PATH/yaffle"
 *   source = "${var.registry_host}/ORG--REPO/WORKSPACE--PATH/yaffle"
 *
 * Where:
 * - ORG--REPO is the namespace (e.g., `yaffle-dot-dev--yaffle`)
 * - WORKSPACE--PATH uses `--` as path separator (e.g., `apps--web--infra`
 *   maps to workspace path `apps/web/infra`)
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import * as hcl from "hcl2-parser"

export type DependencyScannerVariableValue = string | number | boolean

export type DependencyScannerVariableBindings = Record<string, DependencyScannerVariableValue>

export type DependencyScannerVariableBindingsByPath = Record<
  string,
  DependencyScannerVariableBindings
>

export interface DependencyScannerOptions {
  allowedHosts?: string[]
  variables?: DependencyScannerVariableBindings
  currentNamespace?: string
}

type DependencyScannerFilterOptions = Omit<DependencyScannerOptions, "variables">

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

const DEFAULT_ALLOWED_MODULE_HOSTS = ["yaffle.dev", "yaffle.local", ".ts.net"]
const INTERPOLATION_PATTERN = /\$\{\s*(var|local)\.([A-Za-z0-9_]+)\s*\}/g

interface ParsedHclDocument {
  variable?: Record<string, Array<Record<string, unknown>>>
  locals?: Array<Record<string, unknown>>
  module?: Record<string, Array<Record<string, unknown>>>
}

interface ResolutionContext {
  variables: Map<string, string>
  locals: Map<string, string>
}

function getAllowedModuleHosts(options?: DependencyScannerOptions): string[] {
  if (options?.allowedHosts) {
    return options.allowedHosts
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

function normalizeNamespace(namespace: string): string {
  return namespace.trim().toLowerCase()
}

function parseYaffleModuleWorkspacePath(
  source: string,
  allowedHosts: string[],
  currentNamespace?: string,
): string | null {
  if (source.includes("://")) {
    return null
  }

  const parts = source.split("/")
  if (parts.length !== 4) {
    return null
  }

  const [hostWithOptionalPort, namespace, moduleName, providerWithQuery] = parts
  const provider = providerWithQuery.split("?")[0]
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

  if (currentNamespace && normalizeNamespace(namespace) !== normalizeNamespace(currentNamespace)) {
    return null
  }

  return moduleNameToWorkspacePath(moduleName)
}

function parseHclDocument(content: string): ParsedHclDocument | null {
  try {
    const parsed = hcl.parseToObject(content)
    const document = Array.isArray(parsed) ? parsed[0] : parsed
    if (!document || typeof document !== "object") {
      return null
    }

    return document as ParsedHclDocument
  } catch {
    return null
  }
}

function resolveExpressionValue(value: string, context: ResolutionContext): string | null {
  const resolvedValue = value.replace(INTERPOLATION_PATTERN, (match, scope, name) => {
    const resolved = scope === "var" ? context.variables.get(name) : context.locals.get(name)
    return resolved ?? match
  })

  return resolvedValue.includes("${") ? null : resolvedValue
}

function collectStringAssignments(assignments: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(assignments).flatMap(([name, value]) =>
    typeof value === "string" ? [[name, value] as [string, string]] : [],
  )
}

function optionsVariablesToStrings(
  variables?: DependencyScannerVariableBindings,
): Record<string, string> {
  if (!variables) {
    return {}
  }

  return Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, String(value)]))
}

function buildResolutionContext(
  document: ParsedHclDocument,
  providedVariables?: DependencyScannerVariableBindings,
): ResolutionContext {
  const variables = new Map<string, string>(
    Object.entries(optionsVariablesToStrings(providedVariables)),
  )
  const locals = new Map<string, string>()
  const pendingVariables = new Map<string, string>()
  const pendingLocals = new Map<string, string>()

  for (const [name, entries] of Object.entries(document.variable ?? {})) {
    if (variables.has(name)) {
      continue
    }

    const defaultValue = entries[0]?.default
    if (typeof defaultValue === "string") {
      pendingVariables.set(name, defaultValue)
    }
  }

  for (const localBlock of document.locals ?? []) {
    for (const [name, value] of collectStringAssignments(localBlock)) {
      pendingLocals.set(name, value)
    }
  }

  let madeProgress = true
  while (madeProgress) {
    madeProgress = false

    for (const [name, value] of Array.from(pendingVariables.entries())) {
      const resolved = resolveExpressionValue(value, { variables, locals })
      if (resolved === null) {
        continue
      }

      variables.set(name, resolved)
      pendingVariables.delete(name)
      madeProgress = true
    }

    for (const [name, value] of Array.from(pendingLocals.entries())) {
      const resolved = resolveExpressionValue(value, { variables, locals })
      if (resolved === null) {
        continue
      }

      locals.set(name, resolved)
      pendingLocals.delete(name)
      madeProgress = true
    }
  }

  return { variables, locals }
}

function listModuleSources(document: ParsedHclDocument): string[] {
  const sources: string[] = []

  for (const entries of Object.values(document.module ?? {})) {
    for (const entry of entries) {
      if (typeof entry.source === "string") {
        sources.push(entry.source)
      }
    }
  }

  return sources
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
 * @param options - Optional scanner options
 * @returns Array of workspace paths that are referenced as dependencies
 */
export function extractDependenciesFromContent(
  content: string,
  options?: string[] | DependencyScannerOptions,
): string[] {
  const dependencies: string[] = []
  const normalizedOptions = Array.isArray(options) ? { allowedHosts: options } : options
  const hosts = getAllowedModuleHosts(normalizedOptions)
  const document = parseHclDocument(content)
  if (!document) {
    return dependencies
  }

  const context = buildResolutionContext(document, normalizedOptions?.variables)

  for (const sourceValue of listModuleSources(document)) {
    const resolvedSource = resolveExpressionValue(sourceValue, context)
    if (!resolvedSource) {
      continue
    }

    const workspacePath = parseYaffleModuleWorkspacePath(
      resolvedSource,
      hosts,
      normalizedOptions?.currentNamespace,
    )
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
  workspaceVariables?: DependencyScannerVariableBindings,
  options?: DependencyScannerFilterOptions,
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

  const tfContents: string[] = []
  for (const tfFile of tfFiles) {
    try {
      tfContents.push(await readFile(tfFile, "utf-8"))
    } catch {
      // Skip unreadable files
    }
  }

  const deps = extractDependenciesFromContent(tfContents.join("\n\n"), {
    allowedHosts: options?.allowedHosts,
    currentNamespace: options?.currentNamespace,
    variables: workspaceVariables,
  })

  for (const dep of deps) {
    if (knownWorkspaces.has(dep) && dep !== workspacePath) {
      allDependencies.push(dep)
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
  workspaceVariablesByPath?: DependencyScannerVariableBindingsByPath,
  options?: DependencyScannerFilterOptions,
): Promise<InferredDependencyGraph> {
  const knownWorkspaces = new Set(workspacePaths)
  const edges: [string, string][] = []

  // Scan each workspace
  for (const wsPath of workspacePaths) {
    const result = await scanWorkspace(
      repoDir,
      wsPath,
      knownWorkspaces,
      workspaceVariablesByPath?.[wsPath],
      options,
    )

    for (const dep of result.dependsOn) {
      edges.push([wsPath, dep])
    }
  }

  return {
    workspaces: workspacePaths,
    edges,
  }
}
