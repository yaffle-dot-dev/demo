import { exec } from "../lib/exec"

export async function listChangedFiles(baseSha: string, sha: string): Promise<string[]> {
  const output = await exec([
    "git",
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    baseSha,
    sha,
  ], { quiet: true })

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
