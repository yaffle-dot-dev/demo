export interface HostedLifecyclePayloadOptions {
  canonicalRepoNamespace: string
  environmentName: string
  workspacePath: string
  itemKey: string
  phase: "activation" | "verification"
  outputs: Record<string, unknown>
  headSha: string
  branch: string | null
  baseSha?: string
}

export function buildHostedLifecyclePayload(
  options: HostedLifecyclePayloadOptions,
): Record<string, unknown> {
  return {
    repo_namespace: options.canonicalRepoNamespace,
    environment: options.environmentName,
    workspace_path: options.workspacePath,
    item_key: options.itemKey,
    phase: options.phase,
    outputs: options.outputs,
    git_sha: options.headSha,
    git_branch: options.branch,
    ...(options.baseSha ? { git_base_sha: options.baseSha } : {}),
  }
}
