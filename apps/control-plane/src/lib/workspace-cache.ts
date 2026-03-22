/**
 * Workspace Cache
 *
 * Caches workspace tarballs in S3 for reuse across jobs.
 *
 * Key structure: {org}/{repo}/{sha}/workspace.tar.gz
 *
 * Workspaces are cached by SHA, so multiple PRs with the same commit
 * share the same cached workspace. This is both efficient and correct
 * since the workspace contents are deterministic for a given SHA.
 */

import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { buildOrgResourceTags, toS3ObjectTagging } from "./aws-tags.ts"
import { logger } from "./telemetry.ts"

/**
 * Configuration for the workspace cache.
 */
export interface WorkspaceCacheConfig {
  /** S3 bucket name for workspace cache */
  bucket: string
  /** AWS region */
  region: string
}

/**
 * Get workspace cache configuration from environment.
 */
export function getWorkspaceCacheConfig(): WorkspaceCacheConfig {
  const bucket = process.env.YAFFLE_WORKSPACE_CACHE_BUCKET
  const region = process.env.AWS_REGION ?? "us-east-1"

  if (!bucket) {
    throw new Error("YAFFLE_WORKSPACE_CACHE_BUCKET not configured")
  }

  return { bucket, region }
}

/**
 * Workspace cache for storing and retrieving workspace tarballs.
 */
export class WorkspaceCache {
  private readonly s3: S3Client
  private readonly bucket: string

  constructor(config: WorkspaceCacheConfig) {
    this.s3 = new S3Client({ region: config.region })
    this.bucket = config.bucket
  }

  /**
   * Build S3 key for a workspace.
   */
  private buildKey(org: string, repo: string, sha: string): string {
    return `${org}/${repo}/${sha}/workspace.tar.gz`
  }

  /**
   * Check if a workspace is already cached.
   */
  async exists(org: string, repo: string, sha: string): Promise<boolean> {
    const key = this.buildKey(org, repo, sha)

    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )
      return true
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return false
      }
      throw err
    }
  }

  /**
   * Upload a workspace to the cache.
   *
   * @param orgSlug - Organization slug (used in cache key)
   * @param orgId - Organization ID (used for object tagging)
   * @param repo - Repository name (without org prefix)
   * @param sha - Git commit SHA
   * @param workDir - Local directory containing the cloned workspace
   * @returns S3 key for the uploaded workspace
   */
  async upload(
    orgSlug: string,
    orgId: string,
    repo: string,
    sha: string,
    workDir: string,
  ): Promise<string> {
    const key = this.buildKey(orgSlug, repo, sha)

    // Check if already cached
    const cached = await this.exists(orgSlug, repo, sha)
    if (cached) {
      logger.info("Workspace already cached, skipping upload", {
        org: orgSlug,
        repo,
        sha: sha.slice(0, 7),
        key,
      })
      return key
    }

    // Create tarball of the entire workspace
    const tarballPath = join(tmpdir(), `yaffle-ws-${sha.slice(0, 7)}.tar.gz`)

    logger.info("Creating workspace tarball", {
      org: orgSlug,
      repo,
      sha: sha.slice(0, 7),
      workDir,
    })

    const tarResult = Bun.spawnSync(
      ["tar", "-czf", tarballPath, "-C", workDir, "."],
      { stderr: "pipe", stdout: "pipe" },
    )

    if (tarResult.exitCode !== 0) {
      const stderr = tarResult.stderr.toString()
      throw new Error(`tar failed (exit ${tarResult.exitCode}): ${stderr}`)
    }

    // Upload to S3
    const tarballData = await readFile(tarballPath)

    logger.info("Uploading workspace to S3", {
      org: orgSlug,
      repo,
      sha: sha.slice(0, 7),
      bucket: this.bucket,
      key,
      sizeBytes: tarballData.length,
    })

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: tarballData,
        ContentType: "application/gzip",
        Tagging: toS3ObjectTagging(buildOrgResourceTags(
          { orgId, orgSlug },
          { resourceClass: "workspace-cache" },
        )),
      }),
    )

    // Clean up local tarball
    await rm(tarballPath, { force: true })

    logger.info("Workspace cached successfully", {
      org: orgSlug,
      repo,
      sha: sha.slice(0, 7),
      key,
    })

    return key
  }

  /**
   * Get a presigned URL for downloading a cached workspace.
   *
   * @param s3Key - S3 key (from upload() return value)
   * @param expiresIn - URL expiry in seconds (default: 15 minutes)
   * @returns Presigned download URL
   */
  async getDownloadUrl(s3Key: string, expiresIn: number = 15 * 60): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
      }),
      { expiresIn },
    )
  }

  /**
   * Get a presigned URL for a workspace by org/repo/sha.
   * Convenience method that combines buildKey + getDownloadUrl.
   */
  async getDownloadUrlForSha(
    org: string,
    repo: string,
    sha: string,
    expiresIn: number = 15 * 60,
  ): Promise<string> {
    const key = this.buildKey(org, repo, sha)
    return this.getDownloadUrl(key, expiresIn)
  }

  async extractWorkspaceToTemp(s3Key: string): Promise<string> {
    const outputDir = join(tmpdir(), `yaffle-ws-cache-${Date.now()}`)
    const tarballPath = join(tmpdir(), `yaffle-ws-cache-${Date.now()}.tar.gz`)

    await mkdir(outputDir, { recursive: true })

    const object = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
    }))

    const bytes = await object.Body?.transformToByteArray()
    if (!bytes) {
      throw new Error(`Failed to read workspace cache object: ${s3Key}`)
    }

    await Bun.write(tarballPath, bytes)

    const extract = Bun.spawnSync([
      "tar",
      "-xzf",
      tarballPath,
      "-C",
      outputDir,
    ], {
      stderr: "pipe",
      stdout: "pipe",
    })

    if (extract.exitCode !== 0) {
      throw new Error(`Failed to extract workspace cache ${s3Key}: ${extract.stderr.toString()}`)
    }

    await rm(tarballPath, { force: true })
    return outputDir
  }

  private isNotFoundError(err: unknown): boolean {
    return (
      err instanceof Error &&
      "name" in err &&
      (err.name === "NoSuchKey" || err.name === "NotFound" || err.name === "404")
    )
  }
}

/**
 * Create a WorkspaceCache instance from environment configuration.
 */
export function createWorkspaceCache(): WorkspaceCache {
  const config = getWorkspaceCacheConfig()
  return new WorkspaceCache(config)
}
