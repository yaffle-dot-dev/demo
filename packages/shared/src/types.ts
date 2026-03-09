export type PreviewStatus =
  | "pending"
  | "planning"
  | "applying"
  | "awaiting_approval"
  | "ready"
  | "failed"
  | "destroying"
  | "destroyed"

export type RunType = "plan" | "apply" | "destroy"

export type RunStatus = "pending" | "running" | "success" | "failed" | "cancelled"

export type RunnerMode = "saas" | "byoa"

export type JobStatus = "pending" | "running" | "completed" | "failed"

export type PullRequestAction =
  | "opened"
  | "synchronize"
  | "closed"
  | "reopened"

/**
 * Context for a pull_request webhook event.
 */
export interface PullRequestContext {
  kind: "pull_request"
  installationId: number
  ownerGithubId: number
  owner: string
  repo: string
  prNumber: number
  action: PullRequestAction
  headSha: string
  branch: string
  /** GitHub user ID (stable identifier) */
  authorGithubId: number
  /** GitHub username (for display, can change) */
  authorLogin: string
  merged: boolean
  defaultBranch: string
}

/**
 * Context for a push webhook event (push to default branch).
 */
export interface PushContext {
  kind: "push"
  installationId: number
  ownerGithubId: number
  owner: string
  repo: string
  headSha: string
  branch: string
  /** GitHub user ID of the pusher (from sender object) */
  pusherGithubId: number | null
  /** GitHub username of the pusher (from sender object) */
  pusherLogin: string | null
  defaultBranch: string
}

export type WebhookContext = PullRequestContext | PushContext

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
