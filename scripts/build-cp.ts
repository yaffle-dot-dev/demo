import { exec } from "./lib/exec"
import { getConfig, imageUri } from "./lib/env"
import { loginToEcr } from "./lib/ecr"

export async function buildCp() {
  const { registry, tier, sha, shouldPush, region } = await getConfig()

  if (shouldPush) {
    await loginToEcr(registry, region)
  }
  const image = imageUri(registry, "control-plane", tier)

  const args = [
    "depot", "build",
    "-f", "apps/control-plane/Dockerfile",
    "--platform", "linux/arm64",
  ]

  if (shouldPush) {
    args.push("--push", "-t", `${image}:sha-${sha}`, "-t", `${image}:latest`)
  }

  args.push(".")
  await exec(args)
}

// Allow running directly: bun run scripts/build-cp.ts
if (import.meta.main) {
  await buildCp()
}
