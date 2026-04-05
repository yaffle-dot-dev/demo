function normalizeWorkspacePath(value: string): string {
  return value.trim().replace(/^\.\//, "")
}

export function getWarmRunnerExcludedWorkspacePaths(): string[] {
  const raw = process.env.YAFFLE_WARM_RUNNER_EXCLUDED_WORKSPACES ?? ""

  return raw
    .split(",")
    .map(normalizeWorkspacePath)
    .filter(Boolean)
}

export function isWarmRunnerWorkspaceExcluded(workspacePath: string): boolean {
  const normalized = normalizeWorkspacePath(workspacePath)
  return getWarmRunnerExcludedWorkspacePaths().includes(normalized)
}
