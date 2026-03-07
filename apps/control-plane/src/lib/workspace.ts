import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { logger } from "./telemetry.ts"

/**
 * Prepare a workspace by cloning the repo and checking out the target SHA.
 * Returns the path to the cloned workspace directory.
 *
 * For local dev, we clone via HTTPS (public repos) or SSH.
 * In production with a GitHub App, we'd use the installation token for auth.
 */
export async function prepareWorkspace(opts: {
  owner: string
  repo: string
  headSha: string
  installationToken?: string
}): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-"))

  const cloneUrl = opts.installationToken
    ? `https://x-access-token:${opts.installationToken}@github.com/${opts.owner}/${opts.repo}.git`
    : `https://github.com/${opts.owner}/${opts.repo}.git`

  // Shallow clone -- we only need the files at the target SHA
  const cloneResult = Bun.spawnSync(
    ["git", "clone", "--depth", "1", cloneUrl, workDir],
    { stderr: "pipe", stdout: "pipe" },
  )

  if (cloneResult.exitCode !== 0) {
    const stderr = cloneResult.stderr.toString()
    await cleanupWorkspace(workDir)
    throw new Error(`git clone failed (exit ${cloneResult.exitCode}): ${stderr}`)
  }

  // Fetch the specific SHA and checkout
  // For shallow clones with --depth 1, the default branch is already checked out.
  // If the headSha differs from HEAD, we need to fetch it explicitly.
  const headResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: workDir,
    stdout: "pipe",
  })
  const currentHead = headResult.stdout.toString().trim()

  logger.info(`workspace clone check: requested=${opts.headSha} cloned=${currentHead}`, {
    "workspace.requested_sha": opts.headSha,
    "workspace.cloned_sha": currentHead,
    "workspace.sha_match": currentHead === opts.headSha,
  })

  if (currentHead !== opts.headSha) {
    const fetchResult = Bun.spawnSync(
      ["git", "fetch", "origin", opts.headSha, "--depth", "1"],
      { cwd: workDir, stderr: "pipe", stdout: "pipe" },
    )

    if (fetchResult.exitCode !== 0) {
      const stderr = fetchResult.stderr.toString()
      await cleanupWorkspace(workDir)
      throw new Error(`git fetch failed (exit ${fetchResult.exitCode}): ${stderr}`)
    }

    const checkoutResult = Bun.spawnSync(
      ["git", "checkout", opts.headSha],
      { cwd: workDir, stderr: "pipe", stdout: "pipe" },
    )

    if (checkoutResult.exitCode !== 0) {
      const stderr = checkoutResult.stderr.toString()
      await cleanupWorkspace(workDir)
      throw new Error(`git checkout failed (exit ${checkoutResult.exitCode}): ${stderr}`)
    }

    // Verify we're now at the correct SHA
    const verifyResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: workDir,
      stdout: "pipe",
    })
    const finalSha = verifyResult.stdout.toString().trim()
    logger.info(`workspace checkout complete: final=${finalSha}`, {
      "workspace.final_sha": finalSha,
      "workspace.requested_sha": opts.headSha,
      "workspace.checkout_success": finalSha === opts.headSha,
    })
  }

  return workDir
}

/**
 * Remove a workspace directory when we're done with it.
 */
export async function cleanupWorkspace(workDir: string): Promise<void> {
  try {
    await rm(workDir, { recursive: true, force: true })
  } catch (err) {
    logger.warn(`failed to clean up workspace ${workDir}`, {
      "workspace.dir": workDir,
      "error": err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Find terraform directories within a workspace.
 * Looks for directories containing .tf files.
 * Returns paths relative to the workspace root.
 */
export async function findTerraformDirs(workDir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.tf")
  const tfFiles: string[] = []

  for await (const file of glob.scan({ cwd: workDir, absolute: false })) {
    tfFiles.push(file)
  }

  // Deduplicate to unique directories
  const dirs = new Set<string>()
  for (const file of tfFiles) {
    const dir = file.includes("/") ? file.substring(0, file.lastIndexOf("/")) : "."
    dirs.add(dir)
  }

  return Array.from(dirs).sort()
}
