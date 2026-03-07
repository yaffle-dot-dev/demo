import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createHash } from "node:crypto"

import { logger } from "./telemetry.ts"

// =============================================================================
// Configuration
// =============================================================================

export interface TfcS3Config {
  bucket: string
  region: string
}

/**
 * Get TFC state storage configuration from environment.
 */
export function getTfcS3Config(): TfcS3Config {
  const bucket = process.env.YAFFLE_STATE_BUCKET
  const region = process.env.AWS_REGION ?? "us-east-1"

  if (!bucket) {
    throw new Error("YAFFLE_STATE_BUCKET environment variable required")
  }

  return { bucket, region }
}

// Cached S3 client
let s3Client: S3Client | undefined

function getS3Client(region: string): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region })
  }
  return s3Client
}

// =============================================================================
// State Storage Operations
// =============================================================================

/**
 * Build the S3 key for a state version.
 * Pattern: {workspace_id}/v{serial}.tfstate
 */
export function buildStateS3Key(workspaceId: string, serial: number): string {
  return `${workspaceId}/v${serial}.tfstate`
}

/**
 * Upload state content to S3.
 *
 * @param s3Key - The S3 key (e.g., "ws-uuid/v42.tfstate")
 * @param content - The raw state bytes
 * @param expectedMd5 - Expected MD5 hash (hex-encoded) for validation
 * @returns The size of the uploaded content in bytes
 */
export async function uploadState(
  s3Key: string,
  content: Uint8Array,
  expectedMd5?: string,
): Promise<{ size: number; md5: string }> {
  const config = getTfcS3Config()
  const client = getS3Client(config.region)

  // Calculate MD5 of content
  const actualMd5 = createHash("md5").update(content).digest("hex")

  // Validate MD5 if provided
  if (expectedMd5 && actualMd5 !== expectedMd5) {
    throw new StateUploadError(
      `MD5 mismatch: expected ${expectedMd5}, got ${actualMd5}`,
      "MD5_MISMATCH",
    )
  }

  // Upload to S3
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: s3Key,
      Body: content,
      ContentType: "application/json",
      ContentMD5: Buffer.from(actualMd5, "hex").toString("base64"),
    }),
  )

  logger.info("State uploaded to S3", {
    "state.bucket": config.bucket,
    "state.key": s3Key,
    "state.size": content.length,
    "state.md5": actualMd5,
  })

  return { size: content.length, md5: actualMd5 }
}

/**
 * Generate a presigned URL for downloading state from S3.
 *
 * @param s3Key - The S3 key
 * @param expiresInSeconds - URL expiry time (default 5 minutes)
 */
export async function getStateDownloadUrl(
  s3Key: string,
  expiresInSeconds: number = 300,
): Promise<string> {
  const config = getTfcS3Config()
  const client = getS3Client(config.region)

  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: s3Key,
  })

  // @ts-expect-error - S3Client types are slightly incompatible between versions
  const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds })
  return url
}

/**
 * Download state content directly from S3.
 * Use this for streaming to clients without redirect.
 */
export async function downloadState(s3Key: string): Promise<{
  content: Uint8Array
  contentType: string | undefined
}> {
  const config = getTfcS3Config()
  const client = getS3Client(config.region)

  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: s3Key,
    }),
  )

  if (!response.Body) {
    throw new StateDownloadError("Empty response body from S3", "EMPTY_RESPONSE")
  }

  // Convert stream to Uint8Array
  const chunks: Uint8Array[] = []
  const reader = response.Body.transformToWebStream().getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const content = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    content.set(chunk, offset)
    offset += chunk.length
  }

  return {
    content,
    contentType: response.ContentType,
  }
}

// =============================================================================
// Errors
// =============================================================================

export class StateUploadError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "StateUploadError"
  }
}

export class StateDownloadError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "StateDownloadError"
  }
}
