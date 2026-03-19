/**
 * Workspace Download
 *
 * Downloads and extracts workspace tarballs from S3 presigned URLs.
 */

import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Download and extract a workspace from a presigned S3 URL.
 *
 * @param workspaceUrl - Presigned S3 download URL
 * @param workspacePath - Subdirectory within the tarball to use (e.g., "infra")
 * @returns Path to the extracted workspace directory
 */
export async function downloadWorkspace(
  workspaceUrl: string,
  workspacePath: string,
): Promise<string> {
  // Create a temp directory for the workspace
  const workDir = join(tmpdir(), `yaffle-runner-${Date.now()}`)
  await mkdir(workDir, { recursive: true })

  // Download the tarball
  const tarballPath = join(workDir, "workspace.tar.gz")

  const response = await fetch(workspaceUrl)
  if (!response.ok) {
    throw new Error(`Failed to download workspace: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  await Bun.write(tarballPath, arrayBuffer)

  // Extract the tarball
  const extractDir = join(workDir, "extracted")
  await mkdir(extractDir, { recursive: true })

  const tarResult = Bun.spawnSync(
    ["tar", "-xzf", tarballPath, "-C", extractDir],
    { stderr: "pipe", stdout: "pipe" },
  )

  if (tarResult.exitCode !== 0) {
    const stderr = tarResult.stderr.toString()
    throw new Error(`Failed to extract workspace: ${stderr}`)
  }

  // Clean up tarball
  await rm(tarballPath, { force: true })

  // Return the workspace path (subdirectory if specified)
  const finalPath = workspacePath === "." ? extractDir : join(extractDir, workspacePath)

  // Verify the path exists
  const stat = await Bun.file(finalPath).exists()
  if (!stat) {
    // Check if it's a directory
    const dirCheck = Bun.spawnSync(["test", "-d", finalPath])
    if (dirCheck.exitCode !== 0) {
      throw new Error(`Workspace path not found: ${workspacePath}`)
    }
  }

  return finalPath
}

/**
 * Clean up a workspace directory.
 */
export async function cleanupWorkspace(workDir: string): Promise<void> {
  try {
    await rm(workDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}
