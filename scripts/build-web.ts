import { exec } from "./lib/exec"
import { getConfig, imageUri } from "./lib/env"
import { loginToEcr } from "./lib/ecr"

export async function buildWeb() {
  const { registry, tier, sha, shouldPush, region } = await getConfig()

  if (shouldPush) {
    await loginToEcr(registry, region)
  }
  const image = imageUri(registry, "web", tier)

  const args = [
    "depot", "build",
    "-f", "apps/web/Dockerfile",
    "--platform", "linux/arm64",
  ]

  if (shouldPush) {
    args.push("--push", "-t", `${image}:sha-${sha}`, "-t", `${image}:latest`)
  }

  args.push(".")
  await exec(args)
}

if (import.meta.main) {
  await buildWeb()
}
