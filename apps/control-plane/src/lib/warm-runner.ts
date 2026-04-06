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

export function isWarmRunnerAutoLaunchEnabled(): boolean {
  return process.env.YAFFLE_WARM_RUNNER_AUTO_LAUNCH_ENABLED !== "false"
}

export function getWarmRunnerBurstAfterMs(): number {
  return parsePositiveInt(process.env.YAFFLE_WARM_RUNNER_BURST_AFTER_MS, 10_000)
}

export function getWarmRunnerAutoLaunchMaxSlots(): number {
  return parsePositiveInt(process.env.YAFFLE_WARM_RUNNER_AUTO_LAUNCH_MAX_SLOTS, 2)
}

export function getWarmRunnerAutoLaunchMaxRunnersPerOrg(): number {
  return parsePositiveInt(process.env.YAFFLE_WARM_RUNNER_AUTO_LAUNCH_MAX_RUNNERS_PER_ORG, 1)
}

export function getWarmRunnerLaunchGraceMs(): number {
  return parsePositiveInt(process.env.YAFFLE_WARM_RUNNER_LAUNCH_GRACE_MS, 45_000)
}

export function getWarmRunnerHybridConfig(): {
  excludedWorkspacePaths: string[]
  autoLaunchEnabled: boolean
  autoLaunchMaxSlots: number
  autoLaunchMaxRunnersPerOrg: number
  launchGraceMs: number
  burstEnabled: boolean
  burstAfterMs: number
} {
  return {
    excludedWorkspacePaths: getWarmRunnerExcludedWorkspacePaths(),
    autoLaunchEnabled: isWarmRunnerAutoLaunchEnabled(),
    autoLaunchMaxSlots: getWarmRunnerAutoLaunchMaxSlots(),
    autoLaunchMaxRunnersPerOrg: getWarmRunnerAutoLaunchMaxRunnersPerOrg(),
    launchGraceMs: getWarmRunnerLaunchGraceMs(),
    burstEnabled: isWarmRunnerBurstEnabled(),
    burstAfterMs: getWarmRunnerBurstAfterMs(),
  }
}
