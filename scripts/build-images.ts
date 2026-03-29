import { parallel } from "./lib/exec"
import { getConfig } from "./lib/env"
import { loginToEcr } from "./lib/ecr"
import { buildCp } from "./build-cp"
import { buildWeb } from "./build-web"
import { buildRunner } from "./build-runner"

export async function buildImages() {
  const { shouldPush, registry, region } = await getConfig()

  if (shouldPush) {
    await loginToEcr(registry, region)
  }

  await parallel([
    { name: "control-plane", fn: buildCp },
    { name: "web", fn: buildWeb },
    { name: "runner", fn: buildRunner },
  ])
}

if (import.meta.main) {
  await buildImages()
}
