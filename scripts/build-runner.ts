import { exec } from "./lib/exec"
import { getConfig, imageUri } from "./lib/env"
import { loginToEcr } from "./lib/ecr"

export async function buildRunner() {
  const { registry, tier, sha, shouldPush, region } = await getConfig()

  if (shouldPush) {
    await loginToEcr(registry, region)
  }
  const image = imageUri(registry, "runner", tier)

  const args = [
    "depot", "build",
    "-f", "apps/runner/Dockerfile",
    "--platform", "linux/arm64",
  ]

  if (shouldPush) {
    args.push("--push", "-t", `${image}:sha-${sha}`, "-t", `${image}:latest`)
  }

  args.push(".")
  await exec(args)
}

if (import.meta.main) {
  await buildRunner()
}
