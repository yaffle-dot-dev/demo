export type PreviewStatus =
  | "pending"
  | "planning"
  | "applying"
  | "ready"
  | "failed"
  | "destroying"
  | "destroyed"

export type RunType = "plan" | "apply" | "destroy"

export type RunStatus = "pending" | "running" | "success" | "failed"

export type RunnerMode = "saas" | "byoa"

export type JobStatus = "pending" | "running" | "completed" | "failed"

export type PullRequestAction =
  | "opened"
  | "synchronize"
  | "closed"
  | "reopened"

export interface WebhookContext {
  installationId: number
  ownerGithubId: number
  owner: string
  repo: string
  prNumber: number
  action: PullRequestAction
  headSha: string
  branch: string
  merged: boolean
}

export interface TerraformResult {
  success: boolean
  command: RunType
  /** Human-readable plan output (stdout from `tofu plan`) */
  output: string
  /** Structured JSON plan from `tofu show -json` */
  planJson?: unknown
  /** Summary line, e.g. "+3, ~1, -0" */
  planSummary?: string
  /** Outputs from `tofu output -json` after apply */
  outputs?: Record<string, unknown>
  /** Error message if the run failed */
  errorMessage?: string
  /** Duration in milliseconds */
  durationMs: number
}
