function normalizeWorkspacePath(value: string): string {
  return value.trim().replace(/^\.\//, "")
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
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

export function isWarmRunnerBurstEnabled(): boolean {
  return process.env.YAFFLE_WARM_RUNNER_BURST_ENABLED !== "false"
}

export function getWarmRunnerBurstAfterMs(): number {
  return parsePositiveInt(process.env.YAFFLE_WARM_RUNNER_BURST_AFTER_MS, 10_000)
}

export function getWarmRunnerHybridConfig(): {
  excludedWorkspacePaths: string[]
  burstEnabled: boolean
  burstAfterMs: number
} {
  return {
    excludedWorkspacePaths: getWarmRunnerExcludedWorkspacePaths(),
    burstEnabled: isWarmRunnerBurstEnabled(),
    burstAfterMs: getWarmRunnerBurstAfterMs(),
  }
}
