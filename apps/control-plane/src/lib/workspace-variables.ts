import type { WebhookContext } from "@yaffle/shared"

import type {
  EnvironmentKind,
  VariableValue,
  Workspace,
  YaffleTomlConfig,
} from "./config-toml.ts"
import { renderVariables, type TemplateContext } from "./templating.ts"

export type WorkspaceVariablesByPath = Record<string, Record<string, VariableValue>>

function buildWebhookBranchName(ctx: WebhookContext): string {
  if (ctx.kind === "pull_request") {
    return ctx.branch
  }

  return ctx.ref.replace(/^refs\/(heads|tags)\//, "")
}

export function buildWebhookTemplateContext(
  ctx: WebhookContext,
  environmentName: string,
  environmentKind: EnvironmentKind,
  workspacePath: string,
): TemplateContext {
  return {
    environment: environmentName,
    environment_kind: environmentKind,
    org: ctx.owner,
    repo: ctx.repo,
    workspace_path: workspacePath,
    branch: buildWebhookBranchName(ctx),
    commit_sha: ctx.headSha,
    pr_number: ctx.kind === "pull_request" ? ctx.prNumber : null,
  }
}

function findWorkspace(config: YaffleTomlConfig, workspacePath: string): Workspace | undefined {
  return config.workspaces.find((workspace) => workspace.path === workspacePath)
}

export function buildWorkspaceVariablesByPath(
  config: YaffleTomlConfig,
  workspacePaths: string[],
  ctx: WebhookContext,
  environmentName: string,
  environmentKind: EnvironmentKind,
): WorkspaceVariablesByPath {
  const workspaceVariables: WorkspaceVariablesByPath = {}

  for (const workspacePath of workspacePaths) {
    const workspace = findWorkspace(config, workspacePath)
    if (!workspace?.variables) {
      continue
    }

    workspaceVariables[workspacePath] = renderVariables(
      workspace.variables,
      buildWebhookTemplateContext(ctx, environmentName, environmentKind, workspacePath),
      workspacePath,
    )
  }

  return workspaceVariables
}
