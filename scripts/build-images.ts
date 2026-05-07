import { parallel } from "./lib/exec"
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

if (import.meta.main) {
  await buildImages()
}
