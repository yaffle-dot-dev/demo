import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  NoSuchKey,
} from "@aws-sdk/client-s3"

import { logger } from "./telemetry.ts"
import { getTfcS3Config } from "./s3-state.ts"

// Cached S3 client
let s3Client: S3Client | undefined

function getS3Client(region: string): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region })
  }
  return s3Client
}

/**
 * Build the S3 key for a cached module archive.
 * Pattern: {workspace_id}/modules/v{serial}.tar.gz
 */
export function buildModuleS3Key(workspaceId: string, serial: number): string {
  return `${workspaceId}/modules/v${serial}.tar.gz`
}

/**
 * Get a cached module archive from S3.
 * Returns null if the module is not cached.
 */
export async function getCachedModule(
  workspaceId: string,
  serial: number,
): Promise<Uint8Array | null> {
  const config = getTfcS3Config()
  const client = getS3Client(config.region)
  const s3Key = buildModuleS3Key(workspaceId, serial)

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: s3Key,
      }),
    )

    if (!response.Body) {
      return null
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

    logger.debug("Module cache hit", {
      "module.workspaceId": workspaceId,
      "module.serial": serial,
      "module.size": content.length,
    })

    return content
  } catch (err) {
    if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") {
      logger.debug("Module cache miss", {
        "module.workspaceId": workspaceId,
        "module.serial": serial,
      })
      return null
    }
    throw err
  }
}

/**
 * Cache a generated module archive in S3.
 */
export async function cacheModule(
  workspaceId: string,
  serial: number,
  archive: Uint8Array,
): Promise<void> {
  const config = getTfcS3Config()
  const client = getS3Client(config.region)
  const s3Key = buildModuleS3Key(workspaceId, serial)

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: s3Key,
      Body: archive,
      ContentType: "application/gzip",
      // Cache for 1 year - modules are immutable once generated
      CacheControl: "max-age=31536000, immutable",
    }),
  )

  logger.info("Module cached", {
    "module.bucket": config.bucket,
    "module.key": s3Key,
    "module.size": archive.length,
  })
}

/**
 * Get or generate a module archive.
 * Checks cache first, generates and caches if not found.
 */
export async function getOrGenerateModule(
  workspaceId: string,
  serial: number,
  generate: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  // Try cache first
  const cached = await getCachedModule(workspaceId, serial)
  if (cached) {
    return cached
  }

  // Generate the module
  const archive = await generate()

  // Cache for next time (fire and forget)
  cacheModule(workspaceId, serial, archive).catch((err) => {
    logger.warn("Failed to cache module", {
      "module.workspaceId": workspaceId,
      "module.serial": serial,
      error: String(err),
    })
  })

  return archive
}
