import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createHash } from "node:crypto"

import { getAwsClientConfig } from "./aws-client-config.ts"
import { buildOrgResourceTags, toS3ObjectTagging } from "./aws-tags.ts"
import { logger } from "./telemetry.ts"

// =============================================================================
// Configuration
// =============================================================================

export interface TfcS3Config {
  bucket: string
  region: string
}

export function isS3PreconditionFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === 412
  )
}

/**
 * Check if S3 state storage is configured.
 * Returns false when YAFFLE_STATE_BUCKET is not set (e.g., in tests).
 */
export function isS3Configured(): boolean {
  return !!process.env.YAFFLE_STATE_BUCKET
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
    s3Client = new S3Client(getAwsClientConfig(region))
  }
  return s3Client
}

// =============================================================================
// In-Memory State Storage (for tests)
// =============================================================================

// In-memory store for state content when S3 is not configured
const inMemoryStateStore = new Map<string, Uint8Array>()

/**
 * Clear all in-memory state. Call this in test cleanup.
 */
export function clearInMemoryState(): void {
  inMemoryStateStore.clear()
}

// =============================================================================
// State Storage Operations
// =============================================================================

/**
 * Build the S3 key for a state version.
 * Pattern: org-{org_id}/{workspace_id}/v{serial}.tfstate
 *
 * The org prefix enables per-org IAM isolation in the shared S3 bucket.
 */
export function buildStateS3Key(orgId: string, workspaceId: string, serial: number): string {
  return `org-${orgId}/${workspaceId}/v${serial}.tfstate`
}

/**
 * Upload state content to S3 (or in-memory if S3 not configured).
 *
 * @param s3Key - The S3 key (e.g., "org-uuid/ws-uuid/v42.tfstate")
 * @param content - The raw state bytes
 * @param expectedMd5 - Expected MD5 hash (hex-encoded) for validation
 * @param kmsKeyArn - Optional KMS key ARN for per-org encryption
 * @returns The size of the uploaded content in bytes
 */
export async function uploadState(
  s3Key: string,
  content: Uint8Array,
  expectedMd5?: string,
  kmsKeyArn?: string,
  orgId?: string,
): Promise<{ size: number; md5: string }> {
  // Calculate MD5 of content
  const actualMd5 = createHash("md5").update(content).digest("hex")

  // Validate MD5 if provided
  if (expectedMd5 && actualMd5 !== expectedMd5) {
    throw new StateUploadError(
      `MD5 mismatch: expected ${expectedMd5}, got ${actualMd5}`,
      "MD5_MISMATCH",
    )
  }

  // Use in-memory storage if S3 not configured (tests)
  if (!isS3Configured()) {
    if (inMemoryStateStore.has(s3Key)) {
      throw new StateUploadError("State object already uploaded", "STATE_ALREADY_UPLOADED")
    }
    inMemoryStateStore.set(s3Key, content)
    logger.info("State uploaded to in-memory store", {
      "state.key": s3Key,
      "state.size": content.length,
      "state.md5": actualMd5,
    })
    return { size: content.length, md5: actualMd5 }
  }

  const config = getTfcS3Config()
  const client = getS3Client(config.region)

  // Upload to S3 with encryption
  // Use org's KMS key if provided, otherwise bucket default (aws:kms with AWS-managed key)
  const putParams: PutObjectCommandInput = {
    Bucket: config.bucket,
    Key: s3Key,
    Body: content,
    ContentType: "application/json",
    ContentMD5: Buffer.from(actualMd5, "hex").toString("base64"),
    IfNoneMatch: "*",
  }

  if (kmsKeyArn) {
    putParams.ServerSideEncryption = "aws:kms"
    putParams.SSEKMSKeyId = kmsKeyArn
  }

  if (orgId) {
    putParams.Tagging = toS3ObjectTagging(
      buildOrgResourceTags({ orgId }, { resourceClass: "state" }),
    )
  }

  try {
    await client.send(new PutObjectCommand(putParams))
  } catch (error) {
    if (isS3PreconditionFailure(error)) {
      throw new StateUploadError("State object already uploaded", "STATE_ALREADY_UPLOADED")
    }
    throw error
  }

  logger.info("State uploaded to S3", {
    "state.bucket": config.bucket,
    "state.key": s3Key,
    "state.size": content.length,
    "state.md5": actualMd5,
    "state.encryption": kmsKeyArn ? "org-cmk" : "bucket-default",
    "state.kms_key": kmsKeyArn ?? "aws-managed",
  })

  return { size: content.length, md5: actualMd5 }
}

export async function deleteStateObject(s3Key: string): Promise<void> {
  if (!isS3Configured()) {
    inMemoryStateStore.delete(s3Key)
    return
  }
  const config = getTfcS3Config()
  const client = getS3Client(config.region)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: s3Key }))
}

/**
 * Generate a presigned URL for downloading state from S3.
 * For in-memory storage (tests), returns a placeholder URL.
 *
 * @param s3Key - The S3 key
 * @param expiresInSeconds - URL expiry time (default 5 minutes)
 */
export async function getStateDownloadUrl(
  s3Key: string,
  expiresInSeconds: number = 300,
): Promise<string> {
  // For in-memory storage, return a placeholder URL
  // The actual download will use downloadState() directly
  if (!isS3Configured()) {
    return `http://localhost/state/${encodeURIComponent(s3Key)}`
  }

  const config = getTfcS3Config()
  const client = getS3Client(config.region)

  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: s3Key,
  })

  const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds })
  return url
}

/**
 * Download state content directly from S3 (or in-memory if S3 not configured).
 * Use this for streaming to clients without redirect.
 */
export async function downloadState(s3Key: string): Promise<{
  content: Uint8Array
  contentType: string | undefined
}> {
  // Use in-memory storage if S3 not configured (tests)
  if (!isS3Configured()) {
    const content = inMemoryStateStore.get(s3Key)
    if (!content) {
      throw new StateDownloadError(`State not found: ${s3Key}`, "NOT_FOUND")
    }
    return {
      content,
      contentType: "application/json",
    }
  }

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
