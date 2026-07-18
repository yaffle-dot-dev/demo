import { exec } from "../lib/exec"

type GitExec = (command: string[], options: { quiet: boolean }) => Promise<string>

export async function listChangedFiles(
  baseSha: string,
  sha: string,
  run: GitExec = exec,
): Promise<string[]> {
  const output = await run(["git", "diff", "--name-only", "--no-renames", baseSha, sha], {
    quiet: true,
  })

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export async function isAncestorCommit(
  ancestorSha: string,
  descendantSha: string,
  run: GitExec = exec,
): Promise<boolean> {
  try {
    await run(["git", "merge-base", "--is-ancestor", ancestorSha, descendantSha], { quiet: true })
    return true
  } catch {
    return false
  }
}
