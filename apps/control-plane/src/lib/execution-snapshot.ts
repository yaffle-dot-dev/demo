import { createHash } from "node:crypto"

import type { WebhookContext } from "@yaffle/shared"

import {
  resolveApprovers,
  type EnvironmentKind,
  type LifecycleHook,
  type VariableValue,
  type YaffleTomlConfig,
} from "./config-toml.ts"
import type { WorkspaceVariablesByPath } from "./workspace-variables.ts"

export interface ExecutionSnapshotWorkspace {
  path: string
  variables: Record<string, VariableValue>
  approval: {
    required: boolean
    approvers: string[]
  }
  lifecycle: {
    activation: LifecycleHook[]
    verification: LifecycleHook[]
  }
  automaticPreviewIsolation: boolean
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

function sourceRef(ctx: WebhookContext): string {
  return ctx.kind === "pull_request" ? `refs/heads/${ctx.branch}` : ctx.ref
}

function sourceActor(ctx: WebhookContext): { githubId: number | null; login: string | null } {
  if (ctx.kind === "pull_request") {
    return { githubId: ctx.authorGithubId, login: ctx.authorLogin }
  }
  return { githubId: ctx.pusherGithubId, login: ctx.pusherLogin }
}

export function buildExecutionSnapshot(values: {
  ctx: WebhookContext
  config: YaffleTomlConfig
  workspacePaths: string[]
  workspaceVariables: WorkspaceVariablesByPath
  environmentKind: EnvironmentKind
  environmentName: string
}): ExecutionSnapshotV1 {
  const selectedPaths = new Set(values.workspacePaths)
  const workspaces = values.config.workspaces
    .filter((workspace) => selectedPaths.has(workspace.path))
    .map((workspace): ExecutionSnapshotWorkspace => {
      const approvers = resolveApprovers(values.config, workspace.path, values.environmentName)
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
      digest: createHash("sha256").update(stableJson(values.config)).digest("hex"),
    },
    environment: {
      kind: values.environmentKind,
      name: values.environmentName,
      sourcePullRequestNumber: values.ctx.kind === "pull_request" ? values.ctx.prNumber : null,
    },
    workspaces,
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
