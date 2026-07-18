import { isAncestorCommit, listChangedFiles } from "../git"
import type { CiTarget } from "../types"

import type { DeployableArtifactResolution, DiscoveredDeployable } from "./types"

import { imageUri, getConfig } from "../../lib/env"
import { imageTagExists } from "../../lib/ecr"
import { getCurrentServiceImage, getCurrentTaskDefinitionImage } from "../../lib/ecs"
import { resolveControlPlaneDeploymentTarget } from "../../deploy-cp"
import { resolveWebDeploymentTarget } from "../../deploy-web"
import { resolveRunnerTaskDefinition } from "../../deploy-runner"

function matchesPath(filePath: string, watchedPath: string): boolean {
  if (watchedPath.endsWith("/")) {
    return filePath.startsWith(watchedPath)
  }

  return filePath === watchedPath
}

export async function resolveArtifactPlan(values: {
  deployables: DiscoveredDeployable[]
  target: CiTarget
}): Promise<Map<string, DeployableArtifactResolution>> {
  const plan = new Map<string, DeployableArtifactResolution>()

  for (const deployable of values.deployables) {
    const resolution = await resolveDeployableArtifact({
      deployable,
      target: values.target,
    })
    if (resolution) {
      plan.set(deployable.name, resolution)
    }
  }

  return plan
}

const SHA_ARTIFACT_TAG = /:sha-([0-9a-f]{40})$/

export async function hasDeployableChangedSinceArtifact(values: {
  watchedPaths: string[]
  targetSha: string
  currentArtifactRef: string | null
  isAncestor?: (ancestorSha: string, descendantSha: string) => Promise<boolean>
  listChangedFiles?: (baseSha: string, headSha: string) => Promise<string[]>
}): Promise<boolean> {
  const currentArtifactSha = values.currentArtifactRef?.match(SHA_ARTIFACT_TAG)?.[1]
  if (!currentArtifactSha) {
    return true
  }
  if (currentArtifactSha === values.targetSha) {
    return false
  }

  try {
    const hasValidLineage = await (values.isAncestor ?? isAncestorCommit)(
      currentArtifactSha,
      values.targetSha,
    )
    if (!hasValidLineage) {
      return true
    }

    const changedFiles = await (values.listChangedFiles ?? listChangedFiles)(
      currentArtifactSha,
      values.targetSha,
    )
    return changedFiles.some((filePath) =>
      values.watchedPaths.some((watchedPath) => matchesPath(filePath, watchedPath)),
    )
  } catch {
    // An unparseable or unavailable artifact lineage must never suppress a required build.
    return true
  }
}

export function chooseArtifactStrategy(values: {
  deployableName: string
  targetSha: string
  artifactRef: string
  artifactExists: boolean
  changed: boolean
  currentArtifactRef: string | null
}): DeployableArtifactResolution {
  if (values.artifactExists) {
    return {
      strategy: "use_sha_artifact",
      deployableName: values.deployableName,
      changed: values.changed,
      targetSha: values.targetSha,
      artifactRef: values.artifactRef,
    }
  }

  if (!values.changed && values.currentArtifactRef) {
    return {
      strategy: "reuse_previous_artifact",
      deployableName: values.deployableName,
      changed: false,
      targetSha: values.targetSha,
      artifactRef: values.currentArtifactRef,
      reusedFromArtifactRef: values.currentArtifactRef,
    }
  }

  return {
    strategy: "build_missing_artifact",
    deployableName: values.deployableName,
    changed: values.changed,
    targetSha: values.targetSha,
    artifactRef: values.artifactRef,
  }
}

async function resolveDeployableArtifact(values: {
  deployable: DiscoveredDeployable
  target: CiTarget
}): Promise<DeployableArtifactResolution | null> {
  const artifact = values.deployable.artifact
  if (!artifact || artifact.type !== "container-image") {
    return null
  }

  const { registry, tier, region, shouldPush } = await getConfig()
  const sha = values.target.git.sha
  const artifactRef = `${imageUri(registry, artifact.imageName, tier)}:sha-${sha}`
  const artifactExists = shouldPush ? await imageTagExists(artifactRef, region) : false
  if (artifactExists) {
    return chooseArtifactStrategy({
      deployableName: values.deployable.name,
      targetSha: sha,
      artifactRef,
      artifactExists: true,
      changed: true,
      currentArtifactRef: null,
    })
  }

  const resolvedCurrentArtifactRef = await resolveCurrentArtifactRefOrNull(() =>
    resolveCurrentArtifactRef(values.deployable),
  )
  const currentArtifactRef = await resolveReusableCurrentArtifactRef({
    currentArtifactRef: resolvedCurrentArtifactRef,
    shouldPush,
    region,
  })
  const changed = await hasDeployableChangedSinceArtifact({
    watchedPaths: values.deployable.watchedPaths,
    targetSha: sha,
    currentArtifactRef,
  })

  return chooseArtifactStrategy({
    deployableName: values.deployable.name,
    targetSha: sha,
    artifactRef,
    artifactExists,
    changed,
    currentArtifactRef,
  })
}

export async function resolveCurrentArtifactRefOrNull(
  resolve: () => Promise<string | null>,
): Promise<string | null> {
  try {
    return await resolve()
  } catch {
    return null
  }
}

export async function resolveReusableCurrentArtifactRef(values: {
  currentArtifactRef: string | null
  shouldPush: boolean
  region: string
  imageTagExists?: (artifactRef: string, region: string) => Promise<boolean>
}): Promise<string | null> {
  if (!values.currentArtifactRef || !values.shouldPush) {
    return values.currentArtifactRef
  }

  try {
    const exists = await (values.imageTagExists ?? imageTagExists)(
      values.currentArtifactRef,
      values.region,
    )
    return exists ? values.currentArtifactRef : null
  } catch {
    return null
  }
}

async function resolveCurrentArtifactRef(deployable: DiscoveredDeployable): Promise<string | null> {
  const artifact = deployable.artifact
  if (!artifact || artifact.type !== "container-image") {
    return null
  }

  switch (deployable.name) {
    case "control-plane": {
      const { cluster, service } = await resolveControlPlaneDeploymentTarget()
      return getCurrentServiceImage(cluster, service, artifact.containerName)
    }
    case "web": {
      const { cluster, service } = await resolveWebDeploymentTarget()
      return getCurrentServiceImage(cluster, service, artifact.containerName)
    }
    case "runner": {
      const { family } = await resolveRunnerTaskDefinition()
      return getCurrentTaskDefinitionImage(family, artifact.containerName)
    }
    default:
      return null
  }
}
