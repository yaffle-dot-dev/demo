import { createHash } from "node:crypto"

import type { WebhookContext } from "@yaffle/shared"

import {
  resolveApprovers,
  type EnvironmentKind,
  type LifecycleHook,
  type VariableValue,
  type WorkspaceOutputPolicy,
  type YaffleTomlConfig,
} from "./config-toml.ts"
import type { WorkspaceVariablesByPath } from "./workspace-variables.ts"

export interface ExecutionSnapshotWorkspace {
  path: string
  /** Repository-authored, non-secret values. Credentials resolve from connections at execution. */
  variables: Record<string, VariableValue>
  approval: {
    required: boolean
    approvers: string[]
  }
  lifecycle: {
    /** Hook auth stores connection names, never resolved credentials. */
    activation: LifecycleHook[]
    verification: LifecycleHook[]
  }
  outputs: Record<string, WorkspaceOutputPolicy>
  automaticPreviewIsolation: boolean
}

export interface MergeImpactSnapshot {
  environmentName: string
  ref: string
  configurationRevision: string
  configurationDigest: string
  workspaces: Array<{
    path: string
    variables: Record<string, VariableValue>
  }>
}

export interface ExecutionSnapshotV1 {
  version: 1
  source: {
    installationId: number
    repositoryId: number
    ownerId: number
    owner: string
    repository: string
    defaultBranch: string
    ref: string
    commitSha: string
    baseSha: string | null
    actor: {
      githubId: number | null
      login: string | null
    }
  }
  configuration: {
    path: "yaffle.toml"
    revision: string
    digest: string
  }
  environment: {
    kind: EnvironmentKind
    name: string
    sourcePullRequestNumber: number | null
  }
  workspaces: ExecutionSnapshotWorkspace[]
  mergeImpact?: MergeImpactSnapshot
}

export class ExecutionSnapshotInvariantError extends Error {
  readonly code = "EXECUTION_SNAPSHOT_INVARIANT"

  constructor(message: string) {
    super(message)
    this.name = "ExecutionSnapshotInvariantError"
  }
}

export class ExecutionContextAssociationError extends Error {
  readonly code = "EXECUTION_CONTEXT_ASSOCIATION_INVALID"

  constructor(message: string) {
    super(message)
    this.name = "ExecutionContextAssociationError"
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function executionConfigurationDigest(config: YaffleTomlConfig): string {
  return createHash("sha256").update(stableJson(config)).digest("hex")
}

function sourceRef(ctx: WebhookContext): string {
  return ctx.kind === "pull_request" ? `refs/heads/${ctx.branch}` : ctx.ref
}

function sourceActor(ctx: WebhookContext): { githubId: number | null; login: string | null } {
  if (ctx.kind === "pull_request") {
    return { githubId: ctx.authorGithubId, login: ctx.authorLogin }
  }
  return { githubId: ctx.pusherGithubId, login: ctx.pusherLogin }
}

function assertLifecycleUrlsDoNotEmbedCredentials(hooks: LifecycleHook[]): void {
  for (const hook of hooks) {
    const urls = [hook.request?.url, hook.github?.api_url].filter(
      (value): value is string => typeof value === "string",
    )
    for (const rawUrl of urls) {
      const url = new URL(rawUrl)
      if (url.username || url.password || url.search || url.hash) {
        throw new ExecutionSnapshotInvariantError(
          `Lifecycle hook '${hook.key}' must use a connection instead of URL credentials`,
        )
      }
    }
  }
}

export function buildExecutionSnapshot(values: {
  ctx: WebhookContext
  config: YaffleTomlConfig
  workspacePaths: string[]
  workspaceVariables: WorkspaceVariablesByPath
  environmentKind: EnvironmentKind
  environmentName: string
  mergeImpact?: {
    environmentName: string
    ref: string
    configurationRevision: string
    configurationDigest: string
    workspacePaths: string[]
    workspaceVariables: WorkspaceVariablesByPath
  }
}): ExecutionSnapshotV1 {
  const selectedPaths = new Set(values.workspacePaths)
  const workspaces = values.config.workspaces
    .filter((workspace) => selectedPaths.has(workspace.path))
    .map((workspace): ExecutionSnapshotWorkspace => {
      const approvers = resolveApprovers(values.config, workspace.path, values.environmentName)
      assertLifecycleUrlsDoNotEmbedCredentials([
        ...(workspace.activation ?? []),
        ...(workspace.verification ?? []),
      ])
      return {
        path: workspace.path,
        variables: structuredClone(values.workspaceVariables[workspace.path] ?? {}),
        approval: {
          required: approvers.length > 0,
          approvers,
        },
        lifecycle: {
          activation: structuredClone(workspace.activation ?? []),
          verification: structuredClone(workspace.verification ?? []),
        },
        outputs: structuredClone(workspace.outputs ?? {}),
        automaticPreviewIsolation: workspace.automaticPreviewIsolation,
      }
    })

  return {
    version: 1,
    source: {
      installationId: values.ctx.installationId,
      repositoryId: values.ctx.repoGithubId,
      ownerId: values.ctx.ownerGithubId,
      owner: values.ctx.owner,
      repository: values.ctx.repo,
      defaultBranch: values.ctx.defaultBranch,
      ref: sourceRef(values.ctx),
      commitSha: values.ctx.headSha,
      baseSha: values.ctx.kind === "pull_request" ? (values.ctx.baseSha ?? null) : null,
      actor: sourceActor(values.ctx),
    },
    configuration: {
      path: "yaffle.toml",
      revision: values.ctx.headSha,
      digest: executionConfigurationDigest(values.config),
    },
    environment: {
      kind: values.environmentKind,
      name: values.environmentName,
      sourcePullRequestNumber: values.ctx.kind === "pull_request" ? values.ctx.prNumber : null,
    },
    workspaces,
    mergeImpact: values.mergeImpact
      ? {
          environmentName: values.mergeImpact.environmentName,
          ref: values.mergeImpact.ref,
          configurationRevision: values.mergeImpact.configurationRevision,
          configurationDigest: values.mergeImpact.configurationDigest,
          workspaces: values.mergeImpact.workspacePaths.map((path) => ({
            path,
            variables: structuredClone(values.mergeImpact?.workspaceVariables[path] ?? {}),
          })),
        }
      : undefined,
  }
}

export function findExecutionSnapshotWorkspace(
  snapshot: ExecutionSnapshotV1 | null,
  workspacePath: string,
): ExecutionSnapshotWorkspace | undefined {
  if (!snapshot || snapshot.version !== 1) {
    return undefined
  }
  return snapshot.workspaces.find((workspace) => workspace.path === workspacePath)
}

export function buildExecutionVariables(
  snapshot: ExecutionSnapshotV1,
  workspacePath: string,
): Record<string, VariableValue> | undefined {
  const workspace = findExecutionSnapshotWorkspace(snapshot, workspacePath)
  if (!workspace) {
    return undefined
  }
  return {
    environment: snapshot.environment.name,
    environment_kind: snapshot.environment.kind,
    ...workspace.variables,
  }
}

export function buildMergeImpactVariables(
  snapshot: ExecutionSnapshotV1,
  workspacePath: string,
): Record<string, VariableValue> | undefined {
  const target = snapshot.mergeImpact
  const workspace = target?.workspaces.find((candidate) => candidate.path === workspacePath)
  if (!target || !workspace) {
    return undefined
  }
  return {
    environment: target.environmentName,
    environment_kind: "named",
    ...workspace.variables,
  }
}

export function serializeExecutionSnapshotIdentity(snapshot: ExecutionSnapshotV1 | null): {
  version: 1
  commitSha: string
  configurationRevision: string
  configurationDigest: string
} | null {
  if (!snapshot || snapshot.version !== 1) {
    return null
  }
  return {
    version: snapshot.version,
    commitSha: snapshot.source.commitSha,
    configurationRevision: snapshot.configuration.revision,
    configurationDigest: snapshot.configuration.digest,
  }
}

export function serializeBoundExecutionSnapshotIdentity(values: {
  snapshot: ExecutionSnapshotV1 | null
  runGroup: {
    orgId: string
    repo: string
    environmentKind: string
    environmentName: string
  }
  resource: {
    orgId: string
    repo: string
    environmentKind: string
    environmentName: string
    workspacePath?: string
  }
}): ReturnType<typeof serializeExecutionSnapshotIdentity> {
  if (!isExecutionContextAssociationValid(values)) {
    return null
  }

  return serializeExecutionSnapshotIdentity(values.snapshot)
}

export function isExecutionContextAssociationValid(values: {
  snapshot: ExecutionSnapshotV1 | null
  runGroup: {
    orgId: string
    repo: string
    environmentKind: string
    environmentName: string
    ref?: string
    headSha?: string
    selectedWorkspacePaths?: unknown
    repoBindingId?: string | null
  }
  resource: {
    orgId: string
    repo: string
    environmentKind: string
    environmentName: string
    workspacePath?: string
    installationId?: number | null
  }
  canonicalRepoNamespace?: string | null
  requireRepoBinding?: boolean
}): boolean {
  const { snapshot, runGroup, resource } = values
  if (!snapshot || snapshot.version !== 1) {
    return false
  }

  const selectedWorkspacePaths = Array.isArray(runGroup.selectedWorkspacePaths)
    ? runGroup.selectedWorkspacePaths.filter((path): path is string => typeof path === "string")
    : null
  const workspaceMatches =
    resource.workspacePath === undefined ||
    (findExecutionSnapshotWorkspace(snapshot, resource.workspacePath) !== undefined &&
      (selectedWorkspacePaths === null || selectedWorkspacePaths.includes(resource.workspacePath)))
  const canonicalRepoNamespace = `${snapshot.source.owner}--${snapshot.source.repository}`

  return (
    runGroup.orgId === resource.orgId &&
    runGroup.repo === resource.repo &&
    runGroup.environmentKind === resource.environmentKind &&
    runGroup.environmentName === resource.environmentName &&
    snapshot.source.repository === resource.repo &&
    snapshot.environment.kind === resource.environmentKind &&
    snapshot.environment.name === resource.environmentName &&
    (runGroup.ref === undefined || runGroup.ref === snapshot.source.ref) &&
    (runGroup.headSha === undefined || runGroup.headSha === snapshot.source.commitSha) &&
    (resource.installationId === undefined ||
      resource.installationId === null ||
      resource.installationId === snapshot.source.installationId) &&
    workspaceMatches &&
    (!values.requireRepoBinding ||
      (Boolean(runGroup.repoBindingId) && values.canonicalRepoNamespace === canonicalRepoNamespace))
  )
}
