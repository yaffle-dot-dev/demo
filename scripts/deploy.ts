import { parallel } from "./lib/exec"
import { isMain } from "./lib/module"
import { deployCp } from "./deploy-cp"
import { deployWeb } from "./deploy-web"
import { deployRunner } from "./deploy-runner"

export async function deploy() {
  // CP must deploy first — web depends on it being healthy
  await deployCp()

  // Everything else in parallel
  await parallel([
    { name: "web", fn: deployWeb },
    { name: "runner", fn: deployRunner },
  ])
}

if (isMain(import.meta)) {
  await deploy()
}
