export type EnvironmentKind = "named" | "transient"

export interface EnvironmentTarget {
  kind: EnvironmentKind
  name: string
}

export interface GitTargetContext {
  sha: string
  baseSha?: string
  ref?: string
  branch?: string
  prNumber?: number
}

export interface SourceContext {
  kind: "github" | "manual"
  event: string
  action?: string
}

export interface CiTarget {
  environment: EnvironmentTarget
  git: GitTargetContext
  source: SourceContext
}

export type DeployablePlanStatus =
  | "selected"
  | "unchanged"
  | "unsupported_for_target"
  | "not_requested"

export interface DeployablePlanEntry {
  name: string
  status: DeployablePlanStatus
  reasons: string[]
  supportedEnvironmentKinds: EnvironmentKind[]
}

export interface DeployableExecutionResult {
  name: string
  status: "completed" | "failed" | "skipped"
  dependencies: string[]
  workspaces: string[]
  error?: string
}

export interface ConvergeResult {
  target: CiTarget
  deployables: string[]
  workspaces: string[]
  changedFiles: string[]
  mode: "all" | "changed"
  dryRun: boolean
  plan: DeployablePlanEntry[]
  execution: DeployableExecutionResult[]
}
