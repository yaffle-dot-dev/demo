import { getConfig, imageUri } from "./lib/env"
import { loginToEcr } from "./lib/ecr"
import { buildImageArchive, pushImageArchive } from "./lib/nix-image"

export async function buildCp() {
  const { registry, tier, sha, shouldPush, region } = await getConfig()
  const archivePath = await buildImageArchive("control-plane-image")

  if (!shouldPush) {
    return
  }

  await loginToEcr(registry, region)

  const image = imageUri(registry, "control-plane", tier)
  await pushImageArchive(archivePath, `${image}:sha-${sha}`)
  await pushImageArchive(archivePath, `${image}:latest`)
}

// Allow running directly: bun run scripts/build-cp.ts
if (import.meta.main) {
  await buildCp()
}
