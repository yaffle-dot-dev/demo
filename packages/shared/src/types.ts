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
  owner: string
  repo: string
  prNumber: number
  action: PullRequestAction
  headSha: string
  branch: string
  merged: boolean
}
