import { exec } from "./exec"

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
  await exec([
    "skopeo", "copy",
    "--insecure-policy",
    `docker-archive:${archivePath}`,
    `docker://${destination}`,
  ])
}
