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

const outputVisibilitySchema = z.enum(["internal", "public"])

const workspaceOutputPolicySchema = z.object({
  visibility: outputVisibilitySchema,
  consumers: z.array(z.string().min(1, "consumer selector is required")).optional(),
})

const lifecycleWebhookAuthSchema = z.object({
  scheme: z.enum(["bearer", "hmac_sha256"]).optional(),
  secret_ref: z.string().min(1).optional(),
  connection: z.string().min(1).optional(),
})

const lifecycleWebhookRequestSchema = z.object({
  url: z.string().url(),
  method: z.string().optional(),
  auth: lifecycleWebhookAuthSchema.optional(),
})

const lifecycleGitHubDispatchSchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  event_type: z.string().min(1),
  api_url: z.string().url().optional(),
})

const lifecycleHookSchema = z.object({
  key: z.string().min(1, "lifecycle key is required"),
  environments: z.array(z.string().min(1)).optional().default([]),
  kind: z.enum(["webhook", "generic", "generic_hmac", "github_repository_dispatch"]),
  timeout: z.string().min(1).optional(),
  failure: z.enum(["failed", "degraded"]).optional().default("failed"),
  scopes: z.array(z.string().min(1)).optional().default([]),
  request: lifecycleWebhookRequestSchema.optional(),
  github: lifecycleGitHubDispatchSchema.optional(),
})

const workspaceSchema = z.object({
  path: z.string().min(1, "workspace path is required"),
  environments: z.union([
    z.literal("*"),
    z.array(z.string().min(1)),
    z.string().min(1), // Single environment shorthand
  ]),
  variables: z.record(z.string(), variableValueSchema).optional(),
  outputs: z.record(z.string().min(1, "output name is required"), workspaceOutputPolicySchema).optional(),
  activation: z.array(lifecycleHookSchema).optional().default([]),
  verification: z.array(lifecycleHookSchema).optional().default([]),
})

const refPatternSchema = z.string().min(1, "ref pattern is required")

const pushTriggerSchema = z.object({
  ref: refPatternSchema.optional(),
  ref_patterns: z.array(refPatternSchema).min(1, "ref_patterns must contain at least one pattern").optional(),
  exclude_ref_patterns: z.array(refPatternSchema).optional(),
  environment: z.string().min(1, "environment is required"),
}).superRefine((data, ctx) => {
  const hasLegacyRef = data.ref !== undefined
  const hasRefPatterns = data.ref_patterns !== undefined

  if (!hasLegacyRef && !hasRefPatterns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ref_patterns"],
      message: "ref or ref_patterns is required",
    })
  }

  if (hasLegacyRef && hasRefPatterns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ref_patterns"],
      message: "ref and ref_patterns cannot both be set",
    })
  }

  addRefPatternValidationIssues(ctx, "ref", data.ref)
  addRefPatternValidationIssues(ctx, "ref_patterns", data.ref_patterns)
  addRefPatternValidationIssues(ctx, "exclude_ref_patterns", data.exclude_ref_patterns)
})

function addRefPatternValidationIssues(
  ctx: z.RefinementCtx,
  field: "ref" | "ref_patterns" | "exclude_ref_patterns",
  value: string | string[] | undefined,
): void {
  const patterns = typeof value === "string" ? [value] : value ?? []

  for (const [index, pattern] of patterns.entries()) {
    const message = getRefPatternValidationError(pattern, field === "ref" ? "ref" : "ref pattern")
    if (!message) {
      continue
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: field === "ref" ? [field] : [field, index],
      message,
    })
  }
}

function getRefPatternValidationError(pattern: string, label: "ref" | "ref pattern"): string | null {
  if (!pattern.startsWith("refs/heads/") && !pattern.startsWith("refs/tags/")) {
    return `${label} must start with "refs/heads/" or "refs/tags/"`
  }

  const prefix = pattern.startsWith("refs/heads/") ? "refs/heads/" : "refs/tags/"
  if (pattern.length <= prefix.length) {
    return `${label} must have a name after the prefix`
  }

  return null
}

const triggerPatternSchema = z.string().min(1, "branch pattern is required")

const pullRequestTriggerSchema = z.object({
  branch_pattern: triggerPatternSchema.optional(),
  branch_patterns: z.array(triggerPatternSchema).min(1, "branch_patterns must contain at least one pattern")
    .optional(),
  exclude_branch_patterns: z.array(triggerPatternSchema).optional(),
}).superRefine((data, ctx) => {
  const hasLegacyPattern = data.branch_pattern !== undefined
  const hasBranchPatterns = data.branch_patterns !== undefined

  if (!hasLegacyPattern && !hasBranchPatterns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["branch_patterns"],
      message: "branch_pattern or branch_patterns is required",
    })
  }

  if (hasLegacyPattern && hasBranchPatterns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["branch_patterns"],
      message: "branch_pattern and branch_patterns cannot both be set",
    })
  }
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

const cloudSchema = z.object({
  triggers: triggersSchema.optional(),
  approvals: z.array(approvalSchema).optional().default([]),
})

const configSchema = z.object({
  version: z.literal(1),
  environments: z.array(environmentSchema).optional().default([]),
  workspaces: z.array(workspaceSchema).min(1, "at least one workspace is required"),
  cloud: cloudSchema.optional(),
  triggers: z.unknown().optional(),
  approvals: z.unknown().optional(),
}).superRefine((data, ctx) => {
  if (data.triggers !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["triggers"],
      message: "top-level triggers are no longer supported; move them under cloud.triggers",
    })
  }

  if (data.approvals !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approvals"],
      message: "top-level approvals are no longer supported; move them under cloud.approvals",
    })
  }
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
  cloud: CloudConfig
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
  /** Output policy for cross-repo module access within a Yaffle org. */
  outputs?: Record<string, WorkspaceOutputPolicy>
  activation?: LifecycleHook[]
  verification?: LifecycleHook[]
}

export type LifecycleHookKind = "generic" | "generic_hmac" | "github_repository_dispatch"
export type LifecycleFailurePolicy = "failed" | "degraded"

export interface LifecycleWebhookAuth {
  scheme: "bearer" | "hmac_sha256"
  secret_ref?: string
  connection?: string
}

export interface LifecycleWebhookRequest {
  url: string
  method: string
  auth?: LifecycleWebhookAuth
}

export interface LifecycleGitHubDispatch {
  owner?: string
  repo?: string
  event_type: string
  api_url?: string
}

export interface LifecycleHook {
  key: string
  environments: string[]
  kind: LifecycleHookKind
  timeout?: string
  failure: LifecycleFailurePolicy
  scopes: string[]
  request?: LifecycleWebhookRequest
  github?: LifecycleGitHubDispatch
}

export type OutputVisibility = z.infer<typeof outputVisibilitySchema>

export interface WorkspaceOutputPolicy {
  visibility: OutputVisibility
  consumers?: string[]
}

export interface ConsumerSelector {
  orgPattern: string
  repoPattern: string
  workspacePattern: string
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

export interface CloudConfig {
  triggers: Triggers
  approvals: Approval[]
}

export interface Triggers {
  github?: GitHubTriggers
}

export interface GitHubTriggers {
  push?: PushTrigger[]
  pull_request?: PullRequestTrigger[]
}

export interface PushTrigger {
  /** Include globs for full refs like refs/heads/main or refs/tags/v*. */
  ref_patterns: string[]
  /** Glob patterns to exclude after include matching. Excludes always win. */
  exclude_ref_patterns: string[]
  /** Must reference a declared environment */
  environment: string
}

export interface PullRequestTrigger {
  /** Glob patterns for head branch. Any include match is sufficient. */
  branch_patterns: string[]
  /** Glob patterns to exclude after include matching. Excludes always win. */
  exclude_branch_patterns: string[]
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

  rejectUnsupportedWorkspaceExportSyntax(parsed)

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
    outputs: ws.outputs,
    activation: ws.activation.map(normalizeLifecycleHook),
    verification: ws.verification.map(normalizeLifecycleHook),
  }))

  const triggerRoot = raw.cloud?.triggers

  const pushTriggers = triggerRoot?.github?.push?.map((trigger) => ({
    ref_patterns: trigger.ref_patterns ?? [trigger.ref!],
    exclude_ref_patterns: trigger.exclude_ref_patterns ?? [],
    environment: trigger.environment,
  }))

  const pullRequestTriggers = triggerRoot?.github?.pull_request?.map((trigger) => ({
    branch_patterns: trigger.branch_patterns ?? [trigger.branch_pattern!],
    exclude_branch_patterns: trigger.exclude_branch_patterns ?? [],
  }))

  // Build the config
  const config: YaffleTomlConfig = {
    version: 1,
    environments: raw.environments,
    workspaces,
    cloud: {
      triggers: {
        github: triggerRoot?.github
          ? {
            push: pushTriggers,
            pull_request: pullRequestTriggers,
          }
          : undefined,
      },
      approvals: raw.cloud?.approvals ?? [],
    },
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

function normalizeLifecycleHook(hook: z.infer<typeof lifecycleHookSchema>): LifecycleHook {
  return {
    key: hook.key,
    environments: hook.environments,
    kind: hook.kind === "webhook" ? "generic" : hook.kind,
    timeout: hook.timeout,
    failure: hook.failure,
    scopes: hook.scopes,
    request: hook.request
      ? {
          url: hook.request.url,
          method: hook.request.method ?? "POST",
          auth: hook.request.auth
            ? {
                scheme: hook.request.auth.scheme ?? (hook.kind === "generic_hmac" ? "hmac_sha256" : "bearer"),
                secret_ref: hook.request.auth.secret_ref,
                connection: hook.request.auth.connection,
              }
            : undefined,
        }
      : undefined,
    github: hook.github
      ? {
          owner: hook.github.owner,
          repo: hook.github.repo,
          event_type: hook.github.event_type,
          api_url: hook.github.api_url,
        }
      : undefined,
  }
}

function rejectUnsupportedWorkspaceExportSyntax(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") {
    return
  }

  const workspaces = (parsed as { workspaces?: unknown }).workspaces
  if (!Array.isArray(workspaces)) {
    return
  }

  for (const workspace of workspaces) {
    if (!workspace || typeof workspace !== "object") {
      continue
    }

    if (!("exports" in workspace)) {
      continue
    }

    const path = typeof (workspace as { path?: unknown }).path === "string"
      ? (workspace as { path: string }).path
      : "<unknown>"

    throw new ConfigError(
      `Invalid yaffle.toml:\n  - Workspace "${path}" uses unsupported [[workspaces.exports]] syntax. Use outputs.<name> = { visibility = "public", consumers = ["org-slug:repo-slug:workspace-pattern"] } instead`,
    )
  }
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

  // 4. Workspace output policies must be well-formed
  for (const ws of config.workspaces) {
    for (const [outputName, policy] of Object.entries(ws.outputs ?? {})) {
      if (policy.visibility === "public" && (!policy.consumers || policy.consumers.length === 0)) {
        errors.push(`Workspace "${ws.path}" public output policy for "${outputName}" must declare at least one consumer selector`)
      }

      if (policy.visibility === "internal" && policy.consumers && policy.consumers.length > 0) {
        errors.push(`Workspace "${ws.path}" internal output policy for "${outputName}" cannot declare consumers`)
      }

      for (const selector of policy.consumers ?? []) {
        if (!parseConsumerSelector(selector)) {
          errors.push(
            `Workspace "${ws.path}" has invalid consumer selector "${selector}" for output "${outputName}". Expected format: <org-slug>:<repo-slug>:<workspace-pattern>`,
          )
        }
      }
    }

    for (const [phase, hooks] of [["activation", ws.activation ?? []], ["verification", ws.verification ?? []]] as const) {
      for (const hook of hooks) {
        if (hook.environments.length === 0) {
          errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" must declare at least one environment pattern`)
        }
        if (hook.scopes.length === 0) {
          errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" must declare at least one scope`)
        }
        if (hook.kind === "generic" || hook.kind === "generic_hmac") {
          if (!hook.request) {
            errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" requires request settings`)
          } else if (hook.request.method !== "POST") {
            errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" only supports POST requests`)
          }

          if (hook.kind === "generic_hmac") {
            const auth = hook.request?.auth
            if (!auth) {
              errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" requires auth for generic_hmac dispatch`)
            } else if (auth.scheme !== "hmac_sha256") {
              errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" must use hmac_sha256 auth for generic_hmac dispatch`)
            }
          }

          const auth = hook.request?.auth
          if (auth) {
            const hasSecretRef = Boolean(auth.secret_ref)
            const hasConnection = Boolean(auth.connection)
            if (hasSecretRef === hasConnection) {
              errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" auth must set exactly one of secret_ref or connection`)
            }
          }
        }

        if (hook.kind === "github_repository_dispatch") {
          if (!hook.github) {
            errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" requires github settings`)
          }
          if (hook.request) {
            errors.push(`Workspace "${ws.path}" ${phase} hook "${hook.key}" does not use request settings for github_repository_dispatch`)
          }
        }
      }
    }
  }

  // 5. Push trigger environments must reference declared environments
  const triggeredEnvs = new Set<string>()
  if (config.cloud.triggers.github?.push) {
    for (const trigger of config.cloud.triggers.github.push) {
      if (!declaredEnvs.has(trigger.environment)) {
        errors.push(
          `Push trigger for refs "${trigger.ref_patterns.join(", ")}" references undeclared environment "${trigger.environment}"`,
        )
      }
      triggeredEnvs.add(trigger.environment)
    }
  }

  // 6. Warning if declared environment has no trigger
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
 * - "prefix/**" matches any branch starting with "prefix/" (any depth)
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

  const regexPattern = globToRegexPattern(pattern, { asteriskMatchesSlash: false })
  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(branch)
}

function globToRegexPattern(
  pattern: string,
  options: { asteriskMatchesSlash: boolean },
): string {
  let regex = ""

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]

    if (char !== "*") {
      regex += escapeRegex(char)
      continue
    }

    const isDoubleWildcard = pattern[i + 1] === "*"

    if (isDoubleWildcard) {
      regex += ".*"
      i += 1
      continue
    }

    regex += options.asteriskMatchesSlash ? ".*" : "[^/]*"
  }

  return regex
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Parse an external consumer selector.
 * Format: <org-slug>:<repo-slug>:<workspace-pattern>
 * The first two colons separate org, repo, and workspace selectors.
 */
export function parseConsumerSelector(selector: string): ConsumerSelector | null {
  const trimmed = selector.trim()
  const firstSeparatorIndex = trimmed.indexOf(":")
  const secondSeparatorIndex = trimmed.indexOf(":", firstSeparatorIndex + 1)
  if (
    firstSeparatorIndex <= 0 ||
    secondSeparatorIndex <= firstSeparatorIndex + 1 ||
    secondSeparatorIndex === trimmed.length - 1
  ) {
    return null
  }

  const orgPattern = trimmed.slice(0, firstSeparatorIndex)
  const repoPattern = trimmed.slice(firstSeparatorIndex + 1, secondSeparatorIndex)
  const workspacePattern = trimmed.slice(secondSeparatorIndex + 1)

  if (!orgPattern || !repoPattern || !workspacePattern) {
    return null
  }

  return {
    orgPattern,
    repoPattern,
    workspacePattern,
  }
}

/**
 * Match an external consumer selector against a concrete workspace reference.
 */
export function matchConsumerSelector(
  selector: string,
  consumer: { org: string; repo: string; workspacePath: string },
): boolean {
  const parsed = parseConsumerSelector(selector)
  if (!parsed) {
    return false
  }

  return matchBranchPattern(parsed.orgPattern, consumer.org) &&
    matchBranchPattern(parsed.repoPattern, consumer.repo) &&
    matchWorkspacePattern(parsed.workspacePattern, consumer.workspacePath)
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

  const regexPattern = globToRegexPattern(pattern, { asteriskMatchesSlash: true })
  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(workspacePath)
}

export function matchEnvironmentPattern(pattern: string, environmentName: string): boolean {
  return matchBranchPattern(pattern, environmentName)
}

/**
 * Find matching push trigger for a ref.
 * Returns the environment name if matched, undefined otherwise.
 *
 * @param config - Parsed config
 * @param ref - Full ref path (e.g., "refs/heads/main", "refs/tags/v1.0.0")
 */
export function findPushTriggerEnvironment(
  config: YaffleTomlConfig,
  ref: string,
): string | undefined {
  const pushTriggers = config.cloud.triggers.github?.push ?? []

  for (const trigger of pushTriggers) {
    if (matchesPatternSet(ref, trigger.ref_patterns, trigger.exclude_ref_patterns, matchRefPattern)) {
      return trigger.environment
    }
  }

  return undefined
}

/**
 * Match a ref against a pattern.
 * Uses the same glob semantics as branch matching.
 */
export function matchRefPattern(pattern: string, ref: string): boolean {
  return matchBranchPattern(pattern, ref)
}

/**
 * Check if a branch matches any pull_request trigger.
 */
export function matchesPullRequestTrigger(
  config: YaffleTomlConfig,
  headBranch: string,
): boolean {
  const prTriggers = config.cloud.triggers.github?.pull_request ?? []

  for (const trigger of prTriggers) {
    if (matchesPatternSet(
      headBranch,
      trigger.branch_patterns,
      trigger.exclude_branch_patterns,
      matchBranchPattern,
    )) {
      return true
    }
  }

  return false
}

function matchesPatternSet(
  value: string,
  includePatterns: string[],
  excludePatterns: string[],
  matcher: (pattern: string, value: string) => boolean,
): boolean {
  const matchesIncludePattern = includePatterns.some((pattern) => matcher(pattern, value))
  if (!matchesIncludePattern) {
    return false
  }

  return !excludePatterns.some((pattern) => matcher(pattern, value))
}

/**
 * Get workspaces that should run for a given environment.
 *
 * @param config - Parsed config
 * @param environmentName - Environment name (e.g., "main", "pr-123")
 * @param isTransient - Whether this is a transient environment, regardless of source
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

  for (const rule of config.cloud.approvals) {
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
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("PR number must be a positive safe integer")
  }

  return `pr-${prNumber}`
}

/**
 * Parse a PR environment name back to its number.
 * Returns undefined if not a valid PR environment name.
 */
export function parsePrEnvironmentName(environmentName: string): number | undefined {
  const match = environmentName.match(/^pr-([1-9]\d*)$/)
  if (!match) return undefined
  const prNumber = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(prNumber) ? prNumber : undefined
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
