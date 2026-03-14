import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import { isValidApproverString, getApproverValidationError } from "./approver.ts"

/**
 * Error thrown when parsing or validating yaffle.toml.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

/**
 * Environment kind discriminator.
 * - "named": Long-lived environments tied to branches (e.g., main, staging)
 * - "transient": Short-lived environments tied to PRs (e.g., pr-123)
 */
export type EnvironmentKind = "named" | "transient"

/**
 * Zod schema for yaffle.toml
 */
const environmentSchema = z.object({
  name: z.string().min(1, "environment name is required"),
})

/** Variable value type: string, number, or boolean */
const variableValueSchema = z.union([z.string(), z.number(), z.boolean()])

const workspaceSchema = z.object({
  path: z.string().min(1, "workspace path is required"),
  environments: z.union([
    z.literal("*"),
    z.array(z.string().min(1)),
    z.string().min(1), // Single environment shorthand
  ]),
  variables: z.record(z.string(), variableValueSchema).optional(),
})

const pushTriggerSchema = z.object({
  branch: z.string().min(1, "branch is required"),
  environment: z.string().min(1, "environment is required"),
})

const pullRequestTriggerSchema = z.object({
  branch_pattern: z.string().min(1, "branch_pattern is required"),
})

const githubTriggersSchema = z.object({
  push: z.array(pushTriggerSchema).optional(),
  pull_request: z.array(pullRequestTriggerSchema).optional(),
})

const triggersSchema = z.object({
  github: githubTriggersSchema.optional(),
})

/** Zod schema for a namespaced approver string (e.g., "github:user:alice") */
const approverStringSchema = z.string().refine(
  (val) => val === "" || isValidApproverString(val),
  (val) => ({
    message: getApproverValidationError(val) ??
      `Invalid approver format: "${val}". Expected: github:user:<username> or github:team:<org>/<team>`,
  }),
)

const approvalSchema = z.object({
  workspaces: z.array(z.string().min(1)),
  environments: z.array(z.string().min(1)),
  approvers: z.array(approverStringSchema), // Empty array is allowed (means no approval required)
})

const configSchema = z.object({
  version: z.literal(1),
  environments: z.array(environmentSchema).optional().default([]),
  workspaces: z.array(workspaceSchema).min(1, "at least one workspace is required"),
  triggers: triggersSchema.optional(),
  approvals: z.array(approvalSchema).optional().default([]),
})

/** Variable value type: string, number, or boolean */
export type VariableValue = string | number | boolean

/**
 * Parsed and validated yaffle.toml configuration.
 */
export interface YaffleTomlConfig {
  version: 1
  environments: Environment[]
  workspaces: Workspace[]
  triggers: Triggers
  approvals: Approval[]
}

export interface Environment {
  name: string
}

export interface Workspace {
  path: string
  /** Environments this workspace deploys to. "*" means all environments. */
  environments: string[] | "*"
  /** Variables to inject into Terraform. Values can be templates. */
  variables?: Record<string, VariableValue>
}

export interface Approval {
  /** Workspace paths or glob patterns. "*" matches all workspaces. */
  workspaces: string[]
  /** Environment names or "*" for all (including transient). */
  environments: string[]
  /**
   * Namespaced approver identifiers. Empty array = no approval required.
   * Format: `<provider>:<type>:<identifier>`
   * Examples: "github:user:alice", "github:team:org/team-slug"
   */
  approvers: string[]
}

export interface Triggers {
  github?: GitHubTriggers
}

export interface GitHubTriggers {
  push?: PushTrigger[]
  pull_request?: PullRequestTrigger[]
}

export interface PushTrigger {
  /** Explicit branch name or glob pattern */
  branch: string
  /** Must reference a declared environment */
  environment: string
}

export interface PullRequestTrigger {
  /** Glob pattern for head branch */
  branch_pattern: string
}

/**
 * Parse and validate a yaffle.toml file.
 *
 * @param input - Raw TOML string content
 * @returns Validated configuration
 * @throws ConfigError on parse or validation failure
 */
export function parseYaffleToml(input: string): YaffleTomlConfig {
  // Parse TOML
  let parsed: unknown
  try {
    parsed = parseToml(input)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`Failed to parse yaffle.toml: ${msg}`)
  }

  // Validate against schema
  const result = configSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    throw new ConfigError(`Invalid yaffle.toml:\n${issues.join("\n")}`)
  }

  const raw = result.data

  // Normalize workspace environments to array format
  const workspaces: Workspace[] = raw.workspaces.map((ws) => ({
    path: ws.path,
    environments: normalizeEnvironments(ws.environments),
    variables: ws.variables,
  }))

  // Build the config
  const config: YaffleTomlConfig = {
    version: 1,
    environments: raw.environments,
    workspaces,
    triggers: {
      github: raw.triggers?.github,
    },
    approvals: raw.approvals,
  }

  // Validate semantic rules
  validateSemantics(config)

  return config
}

/**
 * Normalize environment specifier to array or "*".
 */
function normalizeEnvironments(envs: string | string[] | "*"): string[] | "*" {
  if (envs === "*") return "*"
  if (Array.isArray(envs)) {
    // Check if array contains "*"
    if (envs.includes("*")) return "*"
    return envs
  }
  // Single string shorthand
  return [envs]
}

/**
 * Validate semantic rules that can't be expressed in Zod.
 */
function validateSemantics(config: YaffleTomlConfig): void {
  const errors: string[] = []
  const warnings: string[] = []

  // Build set of declared environment names
  const declaredEnvs = new Set(config.environments.map((e) => e.name))

  // 1. Environment names must be unique
  const envNames = config.environments.map((e) => e.name)
  const duplicateEnvs = envNames.filter((name, i) => envNames.indexOf(name) !== i)
  if (duplicateEnvs.length > 0) {
    errors.push(`Duplicate environment names: ${[...new Set(duplicateEnvs)].join(", ")}`)
  }

  // 2. Workspace paths must be unique
  const paths = config.workspaces.map((ws) => ws.path)
  const duplicatePaths = paths.filter((path, i) => paths.indexOf(path) !== i)
  if (duplicatePaths.length > 0) {
    errors.push(`Duplicate workspace paths: ${[...new Set(duplicatePaths)].join(", ")}`)
  }

  // 3. Workspace environments must reference declared environments or be "*"
  for (const ws of config.workspaces) {
    if (ws.environments !== "*") {
      for (const env of ws.environments) {
        if (!declaredEnvs.has(env)) {
          errors.push(`Workspace "${ws.path}" references undeclared environment "${env}"`)
        }
      }
    }
  }

  // 4. Push trigger environments must reference declared environments
  const triggeredEnvs = new Set<string>()
  if (config.triggers.github?.push) {
    for (const trigger of config.triggers.github.push) {
      if (!declaredEnvs.has(trigger.environment)) {
        errors.push(`Push trigger for branch "${trigger.branch}" references undeclared environment "${trigger.environment}"`)
      }
      triggeredEnvs.add(trigger.environment)
    }
  }

  // 5. Warning if declared environment has no trigger
  for (const env of config.environments) {
    if (!triggeredEnvs.has(env.name)) {
      warnings.push(`Environment "${env.name}" has no push trigger`)
    }
  }

  // Log warnings
  for (const warning of warnings) {
    console.warn(`[yaffle.toml] Warning: ${warning}`)
  }

  // Throw on errors
  if (errors.length > 0) {
    throw new ConfigError(`Invalid yaffle.toml:\n${errors.map((e) => `  - ${e}`).join("\n")}`)
  }
}

/**
 * Match a branch name against a glob pattern.
 *
 * Supported patterns:
 * - "*" matches any string (full match)
 * - "prefix/*" matches any branch starting with "prefix/" (one segment after)
 * - "exact" matches exactly "exact"
 */
export function matchBranchPattern(pattern: string, branch: string): boolean {
  // Exact match
  if (!pattern.includes("*")) {
    return pattern === branch
  }

  // Special case: lone "*" matches everything
  if (pattern === "*") {
    return true
  }

  // Convert glob to regex
  // * matches anything except / (single path segment)
  const regexPattern = pattern
    .split("*")
    .map(escapeRegex)
    .join("[^/]*")

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(branch)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Match a workspace path against a glob pattern.
 *
 * Unlike branch matching, the asterisk matches any path segments until the
 * next literal (e.g., infra/star matches infra/foo/bar/baz, and
 * infra/star/production matches infra/anything/here/production).
 */
export function matchWorkspacePattern(pattern: string, workspacePath: string): boolean {
  // Exact match
  if (!pattern.includes("*")) {
    return pattern === workspacePath
  }

  // Special case: lone "*" matches everything
  if (pattern === "*") {
    return true
  }

  // Convert glob to regex where * matches any characters (including /)
  const regexPattern = pattern
    .split("*")
    .map(escapeRegex)
    .join(".*")

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(workspacePath)
}

/**
 * Find matching push trigger for a branch.
 * Returns the environment name if matched, undefined otherwise.
 */
export function findPushTriggerEnvironment(
  config: YaffleTomlConfig,
  branch: string,
): string | undefined {
  const pushTriggers = config.triggers.github?.push ?? []

  for (const trigger of pushTriggers) {
    if (matchBranchPattern(trigger.branch, branch)) {
      return trigger.environment
    }
  }

  return undefined
}

/**
 * Check if a branch matches any pull_request trigger.
 */
export function matchesPullRequestTrigger(
  config: YaffleTomlConfig,
  headBranch: string,
): boolean {
  const prTriggers = config.triggers.github?.pull_request ?? []

  for (const trigger of prTriggers) {
    if (matchBranchPattern(trigger.branch_pattern, headBranch)) {
      return true
    }
  }

  return false
}

/**
 * Get workspaces that should run for a given environment.
 *
 * @param config - Parsed config
 * @param environmentName - Environment name (e.g., "main", "pr-123")
 * @param isTransient - Whether this is a transient (PR) environment
 * @returns Workspace paths that should run
 */
export function getWorkspacesForEnvironment(
  config: YaffleTomlConfig,
  environmentName: string,
  isTransient: boolean,
): string[] {
  return config.workspaces
    .filter((ws) => {
      if (ws.environments === "*") {
        // "*" matches all environments (both named and transient)
        return true
      }
      // For transient environments, only "*" matches
      if (isTransient) {
        return false
      }
      // For named environments, check if explicitly listed
      return ws.environments.includes(environmentName)
    })
    .map((ws) => ws.path)
}

/**
 * Resolve approvers for a workspace/environment pair.
 *
 * Multiple approval rules can match - returns the union of all matching approvers.
 * Empty result means no approval is required.
 *
 * @param config - Parsed config
 * @param workspacePath - Workspace path (e.g., "infra/production")
 * @param environmentName - Environment name (e.g., "main", "pr-123")
 * @returns Array of unique GitHub usernames who can approve (empty = no approval required)
 */
export function resolveApprovers(
  config: YaffleTomlConfig,
  workspacePath: string,
  environmentName: string,
): string[] {
  const matchingApprovers = new Set<string>()

  for (const rule of config.approvals) {
    // Check if workspace matches any pattern in the rule
    const workspaceMatches = rule.workspaces.some((pattern) =>
      matchWorkspacePattern(pattern, workspacePath)
    )
    if (!workspaceMatches) continue

    // Check if environment matches any pattern in the rule
    const environmentMatches = rule.environments.some((pattern) => {
      if (pattern === "*") return true
      return pattern === environmentName
    })
    if (!environmentMatches) continue

    // Add all approvers from this matching rule
    for (const approver of rule.approvers) {
      matchingApprovers.add(approver)
    }
  }

  return [...matchingApprovers]
}

/**
 * Check if approval is required for a workspace/environment pair.
 *
 * Returns true if at least one approval rule matches AND has non-empty approvers.
 */
export function isApprovalRequired(
  config: YaffleTomlConfig,
  workspacePath: string,
  environmentName: string,
): boolean {
  const approvers = resolveApprovers(config, workspacePath, environmentName)
  return approvers.length > 0
}

/**
 * Build environment name for a PR.
 */
export function buildPrEnvironmentName(prNumber: number): string {
  return `pr-${prNumber}`
}

/**
 * Parse a PR environment name back to its number.
 * Returns undefined if not a valid PR environment name.
 */
export function parsePrEnvironmentName(environmentName: string): number | undefined {
  const match = environmentName.match(/^pr-(\d+)$/)
  if (!match) return undefined
  return parseInt(match[1], 10)
}

/**
 * Error for an invalid workspace path.
 */
export interface WorkspacePathError {
  path: string
  message: string
}

/**
 * Validate that workspace paths exist in the repository.
 *
 * This is a separate function from parseYaffleToml because it requires
 * access to the repository file structure, which the parser doesn't have.
 *
 * @param config - Parsed config
 * @param pathExists - Function to check if a path exists in the repo
 * @returns Array of errors for invalid paths (empty if all valid)
 */
export async function validateWorkspacePaths(
  config: YaffleTomlConfig,
  pathExists: (path: string) => Promise<boolean>,
): Promise<WorkspacePathError[]> {
  const errors: WorkspacePathError[] = []

  await Promise.all(
    config.workspaces.map(async (ws) => {
      const exists = await pathExists(ws.path)
      if (!exists) {
        errors.push({
          path: ws.path,
          message: `Workspace path "${ws.path}" does not exist in the repository`,
        })
      }
    })
  )

  return errors
}
