import { parallel } from "./lib/exec"
import { isMain } from "./lib/module"
import { buildCp } from "./build-cp"
import { buildWeb } from "./build-web"
import { buildRunner } from "./build-runner"

export async function buildImages() {
  await parallel([
    { name: "control-plane", fn: buildCp },
    { name: "web", fn: buildWeb },
    { name: "runner", fn: buildRunner },
  ])
}

if (isMain(import.meta)) {
  await buildImages()
}
