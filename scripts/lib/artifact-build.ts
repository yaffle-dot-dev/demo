import type { DeployableArtifactResolution } from "../ci/deployables/types"

export function shouldSkipArtifactBuild(artifact?: DeployableArtifactResolution): boolean {
  return Boolean(artifact && artifact.strategy !== "build_missing_artifact")
}
