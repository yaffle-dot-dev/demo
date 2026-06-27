import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { exec } from "./exec"

const SKOPEO_REGISTRIES_CONF = `unqualified-search-registries = ["docker.io"]
short-name-mode = "disabled"
`

function getLastNonEmptyLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const lastLine = lines.at(-1)
  if (!lastLine) {
    throw new Error("nix build did not return an output path")
  }

  return lastLine
}

export async function buildImageArchive(packageName: string): Promise<string> {
  console.log(`Building ${packageName}...`)
  const output = await exec([
    "nix", "build",
    "-L",
    "--no-link",
    "--print-out-paths",
    `.#${packageName}`,
  ], { captureStdout: true })

  const archivePath = getLastNonEmptyLine(output)
  console.log(`Built ${packageName}: ${archivePath}`)
  return archivePath
}

export async function pushImageArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  console.log(`Pushing ${archivePath} -> ${destination}`)

  const originalHome = process.env.HOME
  if (!originalHome) {
    throw new Error("HOME must be set to locate container registry credentials")
  }

  const tempHome = await mkdtemp(join(tmpdir(), "yaffle-skopeo-"))
  const containersConfigDir = join(tempHome, ".config", "containers")
  const registriesConfigPath = join(containersConfigDir, "registries.conf")
  await mkdir(containersConfigDir, { recursive: true })
  await writeFile(registriesConfigPath, SKOPEO_REGISTRIES_CONF)

  try {
    await exec([
      "skopeo",
      "--registries-conf", registriesConfigPath,
      "copy",
      "--insecure-policy",
      "--authfile", join(originalHome, ".docker", "config.json"),
      `docker-archive:${archivePath}`,
      `docker://${destination}`,
    ], {
      env: {
        HOME: tempHome,
      },
    })
  } finally {
    await rm(tempHome, { recursive: true, force: true })
  }
}
