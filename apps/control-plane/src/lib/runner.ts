import type { RunType, TerraformResult } from "@yaffle/shared"

/**
 * Interface for running terraform operations.
 * The webhook handler depends on this so we can swap implementations:
 * - LocalRunner: clones repo, shells out to tofu (dev / local)
 * - EcsRunner: triggers ECS Fargate task (production, future)
 * - TestRunner: returns canned results (tests)
 */
export interface Runner {
  /**
   * Execute a terraform command against a single workspace in a repo.
   * The runner is responsible for cloning, backend config, and cleanup.
   */
  run(opts: RunOpts): Promise<TerraformResult>
}

export interface RunOpts {
  owner: string
  repo: string
  headSha: string
  command: RunType
  /** Workspace path from config, e.g. "infra" */
  workspacePath: string
  /** State key, e.g. "previews/pr-42/infra/terraform.tfstate" */
  stateKey: string
  variables?: Record<string, string>
  installationToken?: string
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void

  // Yaffle context for provider tags
  /** Run ID from Yaffle (for tagging resources) */
  runId?: string
  /** PR number (undefined for production runs) */
  prNumber?: number

  // TFC backend options (optional, used when YAFFLE_TFC_API_HOST is set)
  /** TFC workspace ID (UUID) for cleanup on exit */
  tfcWorkspaceId?: string
  /** TFC workspace name (e.g., "preview-pr-42-control-plane-infra") */
  tfcWorkspaceName?: string
  /** Organization slug for TFC backend */
  tfcOrganization?: string
  /** Run token JWT for TFC authentication */
  tfcToken?: string
}

/**
 * Build a state key for a workspace.
 * Preview: previews/pr-{n}/{workspacePath}/terraform.tfstate
 * Production: production/main/{workspacePath}/terraform.tfstate
 */
export function buildStateKey(
  prefix: string,
  workspacePath: string,
): string {
  return `${prefix}/${workspacePath}/terraform.tfstate`
}

/**
 * Build a preview state key prefix for a PR.
 */
export function previewStatePrefix(prNumber: number): string {
  return `previews/pr-${prNumber}`
}

/**
 * Build a production state key prefix.
 */
export function productionStatePrefix(branch: string): string {
  return `production/${branch}`
}
