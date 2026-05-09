/**
 * Workspace Download
 *
 * Downloads and extracts workspace tarballs from S3 presigned URLs.
 */

import { spawnSync } from "node:child_process"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { constants as fsConstants } from "node:fs"

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
  await writeFile(tarballPath, Buffer.from(arrayBuffer))

  // Extract the tarball
  const extractDir = join(workDir, "extracted")
  await mkdir(extractDir, { recursive: true })

  const tarResult = spawnSync(
    "tar",
    ["-xzf", tarballPath, "-C", extractDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  )

  if ((tarResult.status ?? 1) !== 0) {
    const stderr = tarResult.stderr.toString()
    throw new Error(`Failed to extract workspace: ${stderr}`)
  }

  // Clean up tarball
  await rm(tarballPath, { force: true })

  // Return the workspace path (subdirectory if specified)
  const finalPath = workspacePath === "." ? extractDir : join(extractDir, workspacePath)

  // Verify the path exists
  try {
    await access(finalPath, fsConstants.F_OK)
  } catch {
    throw new Error(`Workspace path not found: ${workspacePath}`)
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
