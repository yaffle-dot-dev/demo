import { getConfig, imageUri } from "./lib/env"
import { loginToEcr } from "./lib/ecr"
import { buildImageArchive, pushImageArchive } from "./lib/nix-image"

export async function buildWeb() {
  const { registry, tier, sha, shouldPush, region } = await getConfig()
  const archivePath = await buildImageArchive("web-image")

  if (!shouldPush) {
    return
  }

  await loginToEcr(registry, region)

  const image = imageUri(registry, "web", tier)
  await pushImageArchive(archivePath, `${image}:sha-${sha}`)
  await pushImageArchive(archivePath, `${image}:latest`)
}

if (import.meta.main) {
  await buildWeb()
}
