import { spawnSync } from "node:child_process"
import { glob } from "node:fs/promises"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { getAwsClientConfig } from "./aws-client-config.ts"
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
  const cloneResult = spawnSync("git", ["clone", "--depth", "1", cloneUrl, workDir], {
    stdio: ["ignore", "pipe", "pipe"],
  })

  if ((cloneResult.status ?? 1) !== 0) {
    const stderr = cloneResult.stderr.toString()
    await cleanupWorkspace(workDir)
    throw new Error(`git clone failed (exit ${cloneResult.status ?? 1}): ${stderr}`)
  }

  // Fetch the specific SHA and checkout
  // For shallow clones with --depth 1, the default branch is already checked out.
  // If the headSha differs from HEAD, we need to fetch it explicitly.
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workDir })
  const currentHead = headResult.stdout.toString().trim()

  logger.info(`workspace clone check: requested=${opts.headSha} cloned=${currentHead}`, {
    "workspace.requested_sha": opts.headSha,
    "workspace.cloned_sha": currentHead,
    "workspace.sha_match": currentHead === opts.headSha,
  })

  if (currentHead !== opts.headSha) {
    const fetchResult = spawnSync("git", ["fetch", "origin", opts.headSha, "--depth", "1"], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    })

    if ((fetchResult.status ?? 1) !== 0) {
      const stderr = fetchResult.stderr.toString()
      await cleanupWorkspace(workDir)
      throw new Error(`git fetch failed (exit ${fetchResult.status ?? 1}): ${stderr}`)
    }

    const checkoutResult = spawnSync("git", ["checkout", opts.headSha], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    })

    if ((checkoutResult.status ?? 1) !== 0) {
      const stderr = checkoutResult.stderr.toString()
      await cleanupWorkspace(workDir)
      throw new Error(`git checkout failed (exit ${checkoutResult.status ?? 1}): ${stderr}`)
    }

    // Verify we're now at the correct SHA
    const verifyResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workDir })
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
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Find terraform directories within a workspace.
 * Looks for directories containing .tf files.
 * Returns paths relative to the workspace root.
 */
export async function findTerraformDirs(workDir: string): Promise<string[]> {
  const tfFiles: string[] = []

  for await (const file of glob("**/*.tf", { cwd: workDir, exclude: ["**/node_modules/**"] })) {
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

// =============================================================================
// Workspace Packaging for ECS Runners
// =============================================================================

/**
 * Configuration for workspace packaging.
 */
export interface WorkspacePackagerConfig {
  /** S3 bucket for workspace storage */
  bucket: string
  /** AWS region */
  region: string
  /** Presigned URL expiry in seconds (default: 15 minutes) */
  urlExpirySeconds?: number
}

/**
 * Prepared workspace ready for ECS runner.
 */
export interface PreparedWorkspace {
  /** S3 key where workspace tarball is stored */
  workspaceKey: string
  /** S3 key where results should be uploaded */
  resultsKey: string
  /** S3 key where logs should be uploaded */
  logsKey: string
  /** Presigned URL to download workspace tarball */
  workspaceUrl: string
  /** Presigned URL to upload results JSON */
  resultsUrl: string
  /** Presigned URL to upload logs */
  logsUrl: string
}

/**
 * Packages a workspace for execution by an ECS runner.
 *
 * This function:
 *   1. Creates a tarball of the workspace directory
 *   2. Uploads the tarball to S3
 *   3. Generates presigned URLs for download/upload
 *
 * The runner will:
 *   1. Download the tarball via presigned URL
 *   2. Extract and run tofu
 *   3. Upload results via presigned URL
 */
export class WorkspacePackager {
  private readonly s3: S3Client
  private readonly bucket: string
  private readonly urlExpirySeconds: number

  constructor(config: WorkspacePackagerConfig) {
    this.s3 = new S3Client(getAwsClientConfig(config.region))
    this.bucket = config.bucket
    this.urlExpirySeconds = config.urlExpirySeconds ?? 15 * 60 // 15 minutes
  }

  /**
   * Package a workspace and upload to S3.
   *
   * @param workDir - Local workspace directory to package
   * @param jobId - Job ID for S3 key naming
   * @param workspacePath - Subdirectory within workDir to package (e.g., "infra")
   * @returns Prepared workspace with presigned URLs
   */
  async packageAndUpload(
    workDir: string,
    jobId: string,
    workspacePath: string = ".",
  ): Promise<PreparedWorkspace> {
    const workspaceKey = `workspaces/${jobId}/workspace.tar.gz`
    const resultsKey = `workspaces/${jobId}/results.json`
    const logsKey = `workspaces/${jobId}/logs.txt`

    // Create tarball
    const tarballPath = join(tmpdir(), `yaffle-ws-${jobId}.tar.gz`)
    const sourceDir = workspacePath === "." ? workDir : join(workDir, workspacePath)

    logger.info("Creating workspace tarball", {
      jobId,
      sourceDir,
      tarballPath,
    })

    const tarResult = spawnSync("tar", ["-czf", tarballPath, "-C", sourceDir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    if ((tarResult.status ?? 1) !== 0) {
      const stderr = tarResult.stderr.toString()
      throw new Error(`tar failed (exit ${tarResult.status ?? 1}): ${stderr}`)
    }

    // Upload tarball to S3
    const tarballData = await readFile(tarballPath)

    logger.info("Uploading workspace to S3", {
      jobId,
      bucket: this.bucket,
      key: workspaceKey,
      sizeBytes: tarballData.length,
    })

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: workspaceKey,
        Body: tarballData,
        ContentType: "application/gzip",
      }),
    )

    // Clean up local tarball
    await rm(tarballPath, { force: true })

    // Generate presigned URLs
    const workspaceUrl = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: workspaceKey,
      }),
      { expiresIn: this.urlExpirySeconds },
    )

    const resultsUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: resultsKey,
        ContentType: "application/json",
      }),
      { expiresIn: this.urlExpirySeconds },
    )

    const logsUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: logsKey,
        ContentType: "text/plain",
      }),
      { expiresIn: this.urlExpirySeconds },
    )

    logger.info("Workspace packaged successfully", {
      jobId,
      workspaceKey,
      resultsKey,
      logsKey,
    })

    return {
      workspaceKey,
      resultsKey,
      logsKey,
      workspaceUrl,
      resultsUrl,
      logsUrl,
    }
  }

  /**
   * Fetch results from S3 after runner completes.
   *
   * @param jobId - Job ID
   * @returns Parsed results JSON, or null if not found
   */
  async fetchResults(jobId: string): Promise<Record<string, unknown> | null> {
    const resultsKey = `workspaces/${jobId}/results.json`

    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: resultsKey,
        }),
      )

      const body = await response.Body?.transformToString()
      if (!body) {
        return null
      }

      return JSON.parse(body) as Record<string, unknown>
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return null
      }
      throw err
    }
  }

  /**
   * Fetch logs from S3 after runner completes.
   *
   * @param jobId - Job ID
   * @returns Log content as string, or null if not found
   */
  async fetchLogs(jobId: string): Promise<string | null> {
    const logsKey = `workspaces/${jobId}/logs.txt`

    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: logsKey,
        }),
      )

      return (await response.Body?.transformToString()) ?? null
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return null
      }
      throw err
    }
  }

  /**
   * Clean up workspace artifacts from S3.
   *
   * @param jobId - Job ID
   */
  async cleanup(jobId: string): Promise<void> {
    // TODO: Implement cleanup - delete all objects with prefix workspaces/{jobId}/
    logger.info("Workspace cleanup requested (not yet implemented)", { jobId })
  }

  private isNotFoundError(err: unknown): boolean {
    return (
      err instanceof Error && "name" in err && (err.name === "NoSuchKey" || err.name === "NotFound")
    )
  }
}
