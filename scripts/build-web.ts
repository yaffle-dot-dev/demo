import type { DeployableArtifactResolution } from "./ci/deployables/types"

import { getConfig, imageUri } from "./lib/env"
import { imageTagExists, loginToEcr } from "./lib/ecr"
import { shouldSkipArtifactBuild } from "./lib/artifact-build"
import { isMain } from "./lib/module"
import { buildImageArchive, pushImageArchive } from "./lib/nix-image"

export async function buildWeb(artifact?: DeployableArtifactResolution) {
  if (shouldSkipArtifactBuild(artifact)) {
    if (artifact) {
      console.log(`Skipping web image build (${artifact.strategy}). Using ${artifact.artifactRef}`)
    }
    return
  }

  const { registry, tier, sha, shouldPush, region } = await getConfig()
  const image = imageUri(registry, "web", tier)
  const shaTag = `${image}:sha-${sha}`

  if (!shouldPush) {
    const archivePath = await buildImageArchive("web-image")
    console.log(`Built image archive for local-only use: ${archivePath}`)
    return
  }

  await loginToEcr(registry, region)

  if (await imageTagExists(shaTag, region)) {
    console.log(`Skipping web image build; ${shaTag} already exists in ECR.`)
    return
  }

  const archivePath = await buildImageArchive("web-image")
  await pushImageArchive(archivePath, shaTag)
  await pushImageArchive(archivePath, `${image}:latest`)
}

if (isMain(import.meta)) {
  await buildWeb()
}
