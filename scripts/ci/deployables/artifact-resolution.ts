import { listChangedFiles } from "../git"
import type { CiTarget } from "../types"

import type {
  DeployableArtifactResolution,
  DiscoveredDeployable,
} from "./types"

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

function touchedByChanges(deployable: DiscoveredDeployable, changedFiles: string[]): boolean {
  return changedFiles.some((filePath) =>
    deployable.watchedPaths.some((watchedPath) => matchesPath(filePath, watchedPath)),
  )
}

export async function resolveArtifactPlan(values: {
  deployables: DiscoveredDeployable[]
  target: CiTarget
}): Promise<Map<string, DeployableArtifactResolution>> {
  const plan = new Map<string, DeployableArtifactResolution>()
  const changedFiles = await resolveChangedFiles(values.target)

  for (const deployable of values.deployables) {
    const resolution = await resolveDeployableArtifact({
      deployable,
      target: values.target,
      changedFiles,
    })
    if (resolution) {
      plan.set(deployable.name, resolution)
    }
  }

  return plan
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
  changedFiles: string[] | null
}): Promise<DeployableArtifactResolution | null> {
  const artifact = values.deployable.artifact
  if (!artifact || artifact.type !== "container-image") {
    return null
  }

  const { registry, tier, sha, region, shouldPush } = await getConfig()
  const artifactRef = `${imageUri(registry, artifact.imageName, tier)}:sha-${sha}`
  const artifactExists = shouldPush ? await imageTagExists(artifactRef, region) : false
  const changed = values.changedFiles === null ? true : touchedByChanges(values.deployable, values.changedFiles)

  const currentArtifactRef = !changed
    ? await resolveCurrentArtifactRef(values.deployable)
    : null

  return chooseArtifactStrategy({
    deployableName: values.deployable.name,
    targetSha: sha,
    artifactRef,
    artifactExists,
    changed,
    currentArtifactRef,
  })
}

async function resolveCurrentArtifactRef(
  deployable: DiscoveredDeployable,
): Promise<string | null> {
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

async function resolveChangedFiles(target: CiTarget): Promise<string[] | null> {
  const baseSha = target.git.baseSha ?? await inferBaseSha(target.git.sha)
  if (!baseSha || baseSha === target.git.sha) {
    return null
  }
  return listChangedFiles(baseSha, target.git.sha)
}

async function inferBaseSha(sha: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-list", "--parents", "-n", "1", sha], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    const exitCode = await proc.exited
    if (exitCode !== 0 || !proc.stdout) {
      return undefined
    }
    const output = (await new Response(proc.stdout).text()).trim()
    const parts = output.split(/\s+/).filter(Boolean)
    return parts.length >= 2 ? parts[1] : undefined
  } catch {
    return undefined
  }
}
