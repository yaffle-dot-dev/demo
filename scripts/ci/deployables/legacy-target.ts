import type { CiTarget } from "../types"

export type LegacyDeployTarget = { type: "env"; name: string } | { type: "pr"; prNumber: number }

export function toLegacyDeployTarget(target: CiTarget): LegacyDeployTarget {
  if (target.environment.kind === "named") {
    return {
      type: "env",
      name: target.environment.name,
    }
  }

  if (!target.git.prNumber) {
    throw new Error(
      `Transient environment ${target.environment.name} is missing a PR number for legacy deploy helpers`,
    )
  }

  return {
    type: "pr",
    prNumber: target.git.prNumber,
  }
}
