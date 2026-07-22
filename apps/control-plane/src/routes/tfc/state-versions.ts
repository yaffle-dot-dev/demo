import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { Hono } from "hono"
import { z } from "zod"

import { logger as log } from "../../lib/telemetry.ts"
import {
  findStateVersionById,
  getCurrentStateVersion,
  getLatestStateVersion,
  listStateVersions,
  createStateVersion,
  completeJsonStateUpload,
  finalizeStateVersion,
  discardStateVersion,
  buildS3Key,
  type StateVersion,
} from "../../db/queries/state-versions.ts"
import { findWorkspaceById } from "../../db/queries/workspaces.ts"
import { TFC_SCOPES } from "../../db/queries/api-tokens.ts"
import {
  tfcAuth,
  getTfcStateVersionAccess,
  getTfcWorkspaceAccess,
  requireScopes,
  type TfcAuthContext,
} from "../../middleware/tfc-auth.ts"
import {
  deleteStateObject,
  uploadState,
  getStateDownloadUrl,
  downloadState,
  StateUploadError,
} from "../../lib/s3-state.ts"
import {
  enforceRateLimit,
  readRequestBodyBytes,
  RequestBodyTooLargeError,
} from "../../lib/request-protection.ts"
import { resolveActiveRunCapability } from "../../lib/runner-capability.ts"
import { OutputSelectionError, selectTerraformOutputs } from "../../lib/output-selection.ts"

// Hono context variables for TFC auth
type TfcVariables = {
  tfcAuth: TfcAuthContext
}

/**
 * TFC-compatible state versions API.
 * Implements endpoints for state storage and retrieval.
 */
export const stateVersionsRoute = new Hono<{ Variables: TfcVariables }>()

// All routes require TFC authentication
stateVersionsRoute.use("*", tfcAuth())

/**
 * Unauthenticated state upload route.
 *
 * The TFC API returns presigned URLs for state upload that don't require
 * Bearer token authentication. Terraform's go-tfe client uses doForeignPUTRequest
 * which doesn't send any auth headers.
 *
 * Security is provided by:
 * 1. The state version ID is an unpredictable UUID
 * 2. The state version must be in "pending" status (one-time use)
 * 3. Upload is only valid for a short time after creation
 */
export const stateUploadRoute = new Hono()

const STATE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
const JSON_STATE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
const PENDING_STATE_UPLOAD_TTL_MS = 15 * 60 * 1000
const STATE_UPLOAD_RATE_LIMIT = {
  bucket: "state-upload",
  limit: 30,
  windowMs: 60_000,
} as const

function getPendingUploadExpiryResponse(): Response {
  return Response.json(
    {
      errors: [
        {
          status: "410",
          title: "State upload URL expired",
          detail: "Create a new state version and retry the upload",
        },
      ],
    },
    { status: 410 },
  )
}

function stateUploadTokenMatches(sv: StateVersion, token: string): boolean {
  if (!sv.uploadTokenHash) {
    return false
  }
  const presentedHash = createHash("sha256").update(token).digest()
  const expectedHash = Buffer.from(sv.uploadTokenHash, "hex")
  return (
    expectedHash.length === presentedHash.length && timingSafeEqual(expectedHash, presentedHash)
  )
}

async function ensurePendingUploadIsUsable(sv: StateVersion): Promise<Response | null> {
  if (sv.status !== "pending") {
    return Response.json(
      {
        errors: [
          {
            status: "409",
            title: "State version is not pending",
            detail: `Status is ${sv.status}`,
          },
        ],
      },
      { status: 409 },
    )
  }

  const ageMs = Date.now() - sv.createdAt.getTime()
  if (ageMs > PENDING_STATE_UPLOAD_TTL_MS) {
    await discardStateVersion(sv.id)
    log.warn("State upload failed: state version expired", {
      stateVersionId: sv.id,
      createdAt: sv.createdAt.toISOString(),
      ageMs,
    })
    return getPendingUploadExpiryResponse()
  }

  if (sv.runId && sv.jobId) {
    const workspace = await findWorkspaceById(sv.workspaceId)
    const capability = workspace
      ? await resolveActiveRunCapability({
          runId: sv.runId,
          jobId: sv.jobId,
          workspaceId: sv.workspaceId,
          orgId: workspace.orgId,
        })
      : null
    if (!capability) {
      await discardStateVersion(sv.id)
      log.warn("State upload failed: runner capability is inactive", {
        stateVersionId: sv.id,
        runId: sv.runId,
        jobId: sv.jobId,
        reason: "capability_inactive_or_mismatched",
      })
      return getPendingUploadExpiryResponse()
    }
  }

  return null
}

// =============================================================================
// JSON:API Response Helpers
// =============================================================================

interface JsonApiStateVersion {
  id: string
  type: "state-versions"
  attributes: {
    serial: number
    lineage?: string | null
    md5: string
    size: number
    status: string
    "terraform-version"?: string | null
    "resources-processed": boolean
    "created-at": string
    "hosted-state-upload-url"?: string
    "hosted-state-download-url"?: string
    // JSON state is an alternate representation of the state for TFC UI features
    "hosted-json-state-upload-url"?: string
    "hosted-json-state-download-url"?: string
  }
  relationships?: {
    workspace?: {
      data: { id: string; type: "workspaces" }
    }
  }
}

const TRUSTED_TFC_HOSTS = new Set(["yaffle.dev", "api.yaffle.dev"])

function getTfcRequestBaseUrl(c: {
  req: { header(name: string): string | undefined; url: string }
}): string {
  const host = c.req.header("host")?.trim().toLowerCase()
  if (host && (TRUSTED_TFC_HOSTS.has(host) || host.endsWith(".internal.yaffle.dev"))) {
    log.info("TFC request base URL selected from trusted host", {
      requestHost: host,
      requestPath: new URL(c.req.url).pathname,
    })
    return `https://${host}`
  }

  const fallback = new URL(c.req.url)
  log.warn("TFC request base URL selected from fallback request URL", {
    requestHost: host ?? "",
    fallbackHost: fallback.host,
    requestPath: fallback.pathname,
  })
  return fallback.origin
}

function toJsonApiStateVersion(
  sv: StateVersion,
  baseUrl: string,
  options: {
    includeUploadUrl?: boolean
    includeDownloadUrl?: boolean
    uploadToken?: string
  } = {},
): JsonApiStateVersion {
  if (options.includeUploadUrl || options.includeDownloadUrl) {
    log.info("State version response URL base selected", {
      stateVersionId: sv.id,
      baseHost: new URL(baseUrl).host,
      includeUploadUrl: options.includeUploadUrl ?? false,
      includeDownloadUrl: options.includeDownloadUrl ?? false,
    })
  }

  const result: JsonApiStateVersion = {
    id: sv.id,
    type: "state-versions",
    attributes: {
      serial: sv.serial,
      lineage: sv.lineage,
      md5: sv.md5,
      size: sv.size,
      status: sv.status,
      "terraform-version": sv.terraformVersion,
      "resources-processed": sv.resourcesProcessed,
      "created-at": sv.createdAt.toISOString(),
    },
    relationships: {
      workspace: {
        data: { id: sv.workspaceId, type: "workspaces" },
      },
    },
  }

  if (options.includeUploadUrl && options.uploadToken && sv.status === "pending") {
    result.attributes["hosted-state-upload-url"] =
      `${baseUrl}/tfc/api/v2/state-versions/${sv.id}/upload/${options.uploadToken}`
    // JSON state upload URL - go-tfe uploads JSON state in parallel with raw state
    result.attributes["hosted-json-state-upload-url"] =
      `${baseUrl}/tfc/api/v2/state-versions/${sv.id}/upload-json/${options.uploadToken}`
  }

  if (options.includeDownloadUrl && sv.status === "finalized") {
    result.attributes["hosted-state-download-url"] =
      `${baseUrl}/tfc/api/v2/state-versions/${sv.id}/download`
    // JSON state download URL
    result.attributes["hosted-json-state-download-url"] =
      `${baseUrl}/tfc/api/v2/state-versions/${sv.id}/download-json`
  }

  return result
}

// =============================================================================
// Workspace-scoped routes
// =============================================================================

/**
 * POST /tfc/api/v2/workspaces/:workspace_id/state-versions
 * Create a new state version (phase 1 of two-phase upload).
 */
stateVersionsRoute.post(
  "/workspaces/:workspace_id/state-versions",
  requireScopes(TFC_SCOPES.stateWrite),
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const access = await getTfcWorkspaceAccess(c, wsId)
    if (access instanceof Response) {
      return access
    }

    const { auth, workspace: ws } = access

    // Workspace must be locked by caller
    const expectedLocker = auth.type === "run" ? `run:${auth.runId}` : `user:${auth.userId}`
    if (!ws.locked || ws.lockedBy !== expectedLocker) {
      return c.json(
        {
          errors: [
            {
              status: "409",
              title: "Workspace must be locked",
              detail: ws.locked
                ? ws.lockId
                  ? `Workspace is locked by ${ws.lockedBy}, not ${expectedLocker} (lock ID: ${ws.lockId})`
                  : `Workspace is locked by ${ws.lockedBy}, not ${expectedLocker}`
                : "Workspace is not locked",
            },
          ],
        },
        409,
      )
    }

    // Parse request body
    const body = await c.req.json()
    const schema = z.object({
      data: z.object({
        type: z.literal("state-versions"),
        attributes: z.object({
          serial: z.number().int().min(0),
          md5: z.string().regex(/^[a-f0-9]{32}$/i),
          lineage: z.string().uuid().optional(),
        }),
      }),
    })

    const parseResult = schema.safeParse(body)
    if (!parseResult.success) {
      return c.json(
        {
          errors: [
            {
              status: "422",
              title: "Invalid request body",
              detail: parseResult.error.errors[0]?.message,
            },
          ],
        },
        422,
      )
    }

    const attrs = parseResult.data.data.attributes

    // Check serial is greater than current finalized version
    // If a pending version exists with same serial (failed upload), discard it and retry
    const latest = await getLatestStateVersion(wsId)
    if (latest && attrs.serial <= latest.serial) {
      const pendingExpired =
        latest.status === "pending" &&
        Date.now() - latest.createdAt.getTime() > PENDING_STATE_UPLOAD_TTL_MS
      if (pendingExpired && attrs.serial === latest.serial) {
        log.info("Discarding stale pending state version for retry", {
          stateVersionId: latest.id,
          workspaceId: wsId,
          serial: attrs.serial,
        })
        await discardStateVersion(latest.id)
      } else {
        return c.json(
          {
            errors: [
              {
                status: "409",
                title: "Serial number conflict",
                detail:
                  latest.status === "pending" && attrs.serial === latest.serial
                    ? `Serial ${attrs.serial} already has an upload in progress`
                    : `Serial ${attrs.serial} must be greater than current serial ${latest.serial}`,
              },
            ],
          },
          409,
        )
      }
    }

    // Build S3 key with org prefix for isolation
    const stateVersionId = crypto.randomUUID()
    const s3Key = buildS3Key(ws.orgId, wsId, attrs.serial, stateVersionId)

    // Create state version record
    const uploadToken = randomBytes(32).toString("base64url")
    const uploadTokenHash = createHash("sha256").update(uploadToken).digest("hex")
    let sv: StateVersion
    try {
      sv = await createStateVersion(
        {
          id: stateVersionId,
          workspaceId: wsId,
          serial: attrs.serial,
          lineage: attrs.lineage,
          md5: attrs.md5,
          size: 0, // Will be updated on upload
          s3Key,
          status: "pending",
          runId: auth.type === "run" ? auth.runId : undefined,
          jobId: auth.type === "run" ? auth.jobId : undefined,
          uploadTokenHash,
          lockGeneration: ws.lockGeneration,
          createdBy: expectedLocker,
        },
        auth.type === "run" &&
          auth.runId &&
          auth.jobId &&
          auth.deploymentId &&
          auth.runGroupId &&
          auth.orgId
          ? {
              runId: auth.runId,
              jobId: auth.jobId,
              deploymentId: auth.deploymentId,
              runGroupId: auth.runGroupId,
              workspaceId: wsId,
              orgId: auth.orgId,
            }
          : undefined,
      )
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        return c.json(
          { errors: [{ status: "409", title: "State upload already in progress" }] },
          409,
        )
      }
      throw error
    }

    const response = toJsonApiStateVersion(sv, getTfcRequestBaseUrl(c), {
      includeUploadUrl: true,
      uploadToken,
    })

    log.info("State version created (pending upload)", {
      stateVersionId: sv.id,
      workspaceId: wsId,
      serial: attrs.serial,
    })

    return c.json({ data: response }, 201)
  },
)

/**
 * GET /tfc/api/v2/workspaces/:workspace_id/current-state-version
 * Get the current (latest finalized) state version.
 */
stateVersionsRoute.get(
  "/workspaces/:workspace_id/current-state-version",
  requireScopes(TFC_SCOPES.stateRead),
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const access = await getTfcWorkspaceAccess(c, wsId)
    if (access instanceof Response) {
      return access
    }

    const sv = await getCurrentStateVersion(wsId)
    if (!sv) {
      return c.json({ errors: [{ status: "404", title: "No state version found" }] }, 404)
    }

    log.info("Current state version response", {
      workspaceId: wsId,
      stateVersionId: sv.id,
      requestHost: c.req.header("host") ?? "",
      status: sv.status,
      serial: sv.serial,
    })

    return c.json({
      data: toJsonApiStateVersion(sv, getTfcRequestBaseUrl(c), { includeDownloadUrl: true }),
    })
  },
)

/**
 * GET /tfc/api/v2/workspaces/:workspace_id/current-state-version-outputs
 * Get the outputs from the current (latest finalized) state version.
 *
 * This endpoint allows fetching outputs without full state read permissions.
 * Terraform's `terraform output -json` command uses this endpoint.
 */
stateVersionsRoute.get(
  "/workspaces/:workspace_id/current-state-version-outputs",
  requireScopes(TFC_SCOPES.stateRead),
  async (c) => {
    const wsId = c.req.param("workspace_id")

    log.info("GET current state version outputs", { workspaceId: wsId })

    const access = await getTfcWorkspaceAccess(c, wsId)
    if (access instanceof Response) {
      return access
    }

    const sv = await getCurrentStateVersion(wsId)
    if (!sv) {
      log.warn("GET current state version outputs: no state version found", { workspaceId: wsId })
      return c.json({ errors: [{ status: "404", title: "No state version found" }] }, 404)
    }

    // Check if outputs are still being processed
    if (!sv.resourcesProcessed && sv.outputs === null) {
      log.info("GET current state version outputs: outputs not yet processed", {
        workspaceId: wsId,
        stateVersionId: sv.id,
      })
      return c.json(
        {
          errors: [
            { status: "503", title: "Outputs are being processed", detail: "Retry the request" },
          ],
        },
        503,
      )
    }

    // Convert outputs to JSON:API format
    // Terraform state outputs are stored as: { "output_name": { "value": ..., "type": ..., "sensitive": ... } }
    const outputs = (sv.outputs ?? {}) as Record<
      string,
      { value: unknown; type?: unknown; sensitive?: boolean }
    >
    const data = Object.entries(outputs).map(([name, output]) => ({
      id: `wsout-${sv.id}-${name}`, // Synthetic ID combining state version + output name
      type: "state-version-outputs",
      attributes: {
        name,
        sensitive: output.sensitive ?? false,
        type: typeof output.type === "string" ? output.type : JSON.stringify(output.type),
        value: output.sensitive ? null : output.value,
        "detailed-type": output.type,
      },
      links: {
        self: `/api/v2/state-version-outputs/wsout-${sv.id}-${name}`,
      },
    }))

    log.info("GET current state version outputs: returning outputs", {
      workspaceId: wsId,
      stateVersionId: sv.id,
      outputCount: data.length,
    })

    return c.json({ data })
  },
)

/**
 * GET /tfc/api/v2/state-version-outputs/:id
 * Get a single state version output by its synthetic ID.
 *
 * The ID format is: wsout-{stateVersionId}-{outputName}
 * Terraform CLI follows the self-links from the list endpoint to fetch individual outputs.
 */
stateVersionsRoute.get(
  "/state-version-outputs/:id",
  requireScopes(TFC_SCOPES.stateRead),
  async (c) => {
    const outputId = c.req.param("id")

    // Parse synthetic ID: wsout-{uuid}-{outputName}
    // UUID is 36 chars, so: "wsout-" (6) + UUID (36) + "-" (1) + name
    const prefix = "wsout-"
    if (!outputId.startsWith(prefix)) {
      return c.json({ errors: [{ status: "404", title: "Resource not found" }] }, 404)
    }

    const rest = outputId.slice(prefix.length)
    // UUID format: 8-4-4-4-12 = 36 chars
    const stateVersionId = rest.slice(0, 36)
    const outputName = rest.slice(37) // skip the "-" after UUID

    if (!stateVersionId || !outputName) {
      return c.json({ errors: [{ status: "404", title: "Resource not found" }] }, 404)
    }

    const sv = await findStateVersionById(stateVersionId)
    if (!sv) {
      return c.json({ errors: [{ status: "404", title: "Resource not found" }] }, 404)
    }

    // Access check via workspace
    const access = await getTfcWorkspaceAccess(c, sv.workspaceId)
    if (access instanceof Response) {
      return access
    }

    const outputs = (sv.outputs ?? {}) as Record<
      string,
      { value: unknown; type?: unknown; sensitive?: boolean }
    >
    const output = outputs[outputName]
    if (!output) {
      return c.json({ errors: [{ status: "404", title: "Resource not found" }] }, 404)
    }

    return c.json({
      data: {
        id: outputId,
        type: "state-version-outputs",
        attributes: {
          name: outputName,
          sensitive: output.sensitive ?? false,
          type: typeof output.type === "string" ? output.type : JSON.stringify(output.type),
          value: output.sensitive ? null : output.value,
          "detailed-type": output.type,
        },
        links: {
          self: `/api/v2/state-version-outputs/${outputId}`,
        },
      },
    })
  },
)

// =============================================================================
// State version routes
// =============================================================================

/**
 * GET /tfc/api/v2/state-versions
 * List state versions with filters.
 */
stateVersionsRoute.get("/state-versions", requireScopes(TFC_SCOPES.stateRead), async (c) => {
  const searchParams = new URL(c.req.url).searchParams
  const workspaceName = searchParams.get("filter[workspace][name]")
  const orgName = searchParams.get("filter[organization][name]")
  const workspaceId = searchParams.get("filter[workspace][id]")

  if (!workspaceId && !(workspaceName && orgName)) {
    return c.json(
      {
        errors: [
          {
            status: "400",
            title: "Missing filter",
            detail:
              "Must provide filter[workspace][id] or both filter[workspace][name] and filter[organization][name]",
          },
        ],
      },
      400,
    )
  }

  // For now, require workspace ID (simplest path)
  if (!workspaceId) {
    return c.json({ errors: [{ status: "400", title: "filter[workspace][id] is required" }] }, 400)
  }

  const access = await getTfcWorkspaceAccess(c, workspaceId)
  if (access instanceof Response) {
    return access
  }

  const { items, nextCursor } = await listStateVersions(workspaceId, {
    limit: parseInt(searchParams.get("page[size]") || "20", 10),
    cursor: searchParams.get("page[after]") || undefined,
  })

  return c.json({
    data: items.map((sv) =>
      toJsonApiStateVersion(sv, getTfcRequestBaseUrl(c), { includeDownloadUrl: true }),
    ),
    meta: {
      pagination: {
        "next-page": nextCursor,
      },
    },
  })
})

/**
 * GET /tfc/api/v2/state-versions/:state_version_id
 * Get a state version by ID.
 */
stateVersionsRoute.get(
  "/state-versions/:state_version_id",
  requireScopes(TFC_SCOPES.stateRead),
  async (c) => {
    const svId = c.req.param("state_version_id")

    log.info("GET state version by ID", { stateVersionId: svId })

    const access = await getTfcStateVersionAccess(c, svId)
    if (access instanceof Response) {
      if (access.status === 404) {
        log.warn("GET state version: not found", { stateVersionId: svId })
      }
      return access
    }

    const { stateVersion: sv } = access

    log.info("GET state version: found", {
      stateVersionId: svId,
      status: sv.status,
      serial: sv.serial,
    })

    return c.json({
      data: toJsonApiStateVersion(sv, getTfcRequestBaseUrl(c), {
        includeUploadUrl: sv.status === "pending",
        includeDownloadUrl: sv.status === "finalized",
      }),
    })
  },
)

// Note: The upload endpoint is on the separate stateUploadRoute (no auth required)
// See stateUploadRoute below for the PUT /state-versions/:id/upload handler

/**
 * GET /tfc/api/v2/state-versions/:state_version_id/download
 * Download state content.
 */
stateVersionsRoute.get(
  "/state-versions/:state_version_id/download",
  requireScopes(TFC_SCOPES.stateDownload),
  async (c) => {
    const svId = c.req.param("state_version_id")
    const access = await getTfcStateVersionAccess(c, svId)
    if (access instanceof Response) {
      return access
    }

    const { stateVersion: sv } = access

    log.info("State download request received", {
      stateVersionId: sv.id,
      requestHost: c.req.header("host") ?? "",
      accept: c.req.header("accept") ?? "",
      status: sv.status,
      serial: sv.serial,
    })

    // Must be finalized
    if (sv.status !== "finalized") {
      return c.json({ errors: [{ status: "404", title: "State version is not finalized" }] }, 404)
    }

    // Option 1: Redirect to presigned S3 URL
    // This is more efficient but may have CORS issues
    const useRedirect = c.req.header("accept")?.includes("*/*") ?? true

    if (useRedirect) {
      try {
        const url = await getStateDownloadUrl(sv.s3Key)
        log.info("State download redirecting to object storage", {
          stateVersionId: sv.id,
          redirectHost: new URL(url).host,
        })
        return c.redirect(url, 302)
      } catch (err) {
        log.warn("Failed to generate presigned URL, falling back to proxy", {
          error: String(err),
        })
      }
    }

    // Option 2: Stream directly through Yaffle
    try {
      const { content, contentType } = await downloadState(sv.s3Key)
      log.info("State download proxying through control plane", {
        stateVersionId: sv.id,
        contentType: contentType ?? "application/json",
        contentLength: content.length,
      })
      return new Response(content.buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": contentType ?? "application/json",
          "Content-Length": content.length.toString(),
        },
      })
    } catch (err) {
      log.error("Failed to download state", { error: String(err) })
      return c.json({ errors: [{ status: "500", title: "Failed to download state" }] }, 500)
    }
  },
)

// =============================================================================
// Unauthenticated Upload Route
// =============================================================================

/**
 * PUT /tfc/api/v2/state-versions/:state_version_id/upload
 * Upload state content (phase 2 of two-phase upload).
 *
 * This endpoint does NOT require authentication. Security is provided by:
 * 1. The state version ID is an unpredictable UUID (acts as a one-time token)
 * 2. The state version must be in "pending" status
 * 3. Once uploaded, the status changes to "finalized" (one-time use)
 *
 * This matches TFC behavior where the upload URL is a presigned URL
 * that doesn't require Bearer token authentication.
 */
stateUploadRoute.put("/state-versions/:state_version_id/upload/:upload_token", async (c) => {
  const rateLimitResponse = enforceRateLimit(c, STATE_UPLOAD_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  const svId = c.req.param("state_version_id")
  const uploadToken = c.req.param("upload_token")

  log.info("State upload request received (unauthenticated)", {
    stateVersionId: svId,
    contentType: c.req.header("content-type"),
    contentLength: c.req.header("content-length"),
  })

  const sv = await findStateVersionById(svId)
  if (!sv) {
    log.warn("State upload failed: state version not found", { stateVersionId: svId })
    return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
  }
  if (!stateUploadTokenMatches(sv, uploadToken)) {
    log.warn("State upload failed: invalid upload capability", {
      stateVersionId: svId,
      reason: "upload_capability_mismatch",
    })
    return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
  }

  const pendingResponse = await ensurePendingUploadIsUsable(sv)
  if (pendingResponse) {
    return pendingResponse
  }

  // Get workspace and org for KMS key
  const ws = await findWorkspaceById(sv.workspaceId)
  if (!ws) {
    log.error("State upload failed: workspace not found", {
      stateVersionId: svId,
      workspaceId: sv.workspaceId,
    })
    return c.json({ errors: [{ status: "500", title: "Workspace not found" }] }, 500)
  }

  // Get org's KMS key for encryption
  const { findOrgById } = await import("../../db/queries/organizations.ts")
  const org = await findOrgById(ws.orgId)
  const kmsKeyArn = org?.kmsKeyArn ?? undefined

  // Read body as bytes
  let content: Uint8Array
  try {
    content = await readRequestBodyBytes(c.req.raw, STATE_UPLOAD_MAX_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return c.json({ errors: [{ status: "413", title: "State upload too large" }] }, 413)
    }
    throw err
  }

  // Upload to S3, validating MD5 and using org's KMS key
  try {
    const { size, md5 } = await uploadState(sv.s3Key, content, sv.md5, kmsKeyArn, ws.orgId)

    // Verify MD5 matches what was declared at creation
    if (md5 !== sv.md5) {
      log.warn("State upload failed: MD5 mismatch", {
        stateVersionId: svId,
        expected: sv.md5,
        actual: md5,
      })
      return c.json(
        {
          errors: [
            {
              status: "422",
              title: "MD5 mismatch",
              detail: `Expected ${sv.md5}, got ${md5}`,
            },
          ],
        },
        422,
      )
    }

    // Extract terraform version and outputs from state JSON
    let terraformVersion: string | undefined
    let outputs: Record<string, unknown> | undefined
    try {
      const stateJson = JSON.parse(new TextDecoder().decode(content))
      terraformVersion = stateJson.terraform_version
      outputs = normalizeTerraformStateOutputs(stateJson.outputs)
    } catch (error) {
      if (error instanceof OutputSelectionError) {
        await deleteStateObject(sv.s3Key)
        await discardStateVersion(sv.id)
        return c.json(
          {
            errors: [
              {
                status: "422",
                title: "Invalid Terraform output metadata",
                detail: error.message,
              },
            ],
          },
          422,
        )
      }
      // State might not be valid JSON, that's OK
    }

    // Finalize the state version
    const latestStateVersion = await findStateVersionById(svId)
    if (!latestStateVersion) {
      await deleteStateObject(sv.s3Key)
      return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
    }
    const capabilityResponse = await ensurePendingUploadIsUsable(latestStateVersion)
    if (capabilityResponse) {
      await deleteStateObject(sv.s3Key)
      return capabilityResponse
    }

    const finalized = await finalizeStateVersion(
      svId,
      sv.workspaceId,
      sv.createdBy ?? "",
      terraformVersion,
      outputs,
      sv.runId && sv.jobId ? { runId: sv.runId, jobId: sv.jobId } : undefined,
    )
    if (!finalized) {
      await deleteStateObject(sv.s3Key)
      log.error("State upload failed: could not finalize", { stateVersionId: svId })
      return c.json({ errors: [{ status: "409", title: "State capability changed" }] }, 409)
    }

    log.info("State version uploaded and finalized", {
      stateVersionId: svId,
      workspaceId: sv.workspaceId,
      serial: sv.serial,
      size,
      md5,
    })

    log.info("Sending 200 response for state upload PUT", { stateVersionId: svId })
    // Return response mimicking S3 PUT behavior:
    // - 200 OK
    // - Empty body (Content-Length: 0)
    // - ETag header with MD5 (S3 format uses quotes around the hash)
    // Note: go-tfe's doForeignPUTRequest calls DoJSON(ctx, nil) which expects
    // an empty response body.
    c.header("ETag", `"${md5}"`)
    return c.body(null, 200)
  } catch (err) {
    if (err instanceof StateUploadError) {
      log.warn("State upload failed: S3 error", {
        stateVersionId: svId,
        error: err.message,
      })
      const status = err.code === "STATE_ALREADY_UPLOADED" ? 409 : 422
      return c.json(
        {
          errors: [
            {
              status: String(status),
              title: "Upload failed",
              detail: err.message,
            },
          ],
        },
        status,
      )
    }
    throw err
  }
})

function normalizeTerraformStateOutputs(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputSelectionError(
      "INVALID_TERRAFORM_OUTPUT",
      "Terraform state outputs must be an object",
      [],
    )
  }

  const outputs = Object.fromEntries(
    Object.entries(value).map(([name, output]) => [
      name,
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      "value" in output &&
      !("sensitive" in output)
        ? { ...output, sensitive: false }
        : output,
    ]),
  )

  return (
    selectTerraformOutputs({
      outputs,
      selection: { kind: "all" },
      sensitive: "redact",
    }) ?? undefined
  )
}

/**
 * PUT /tfc/api/v2/state-versions/:state_version_id/upload-json
 * Upload JSON state content (parallel upload with raw state).
 *
 * This endpoint accepts the JSON representation of the state which is used
 * by TFC for enhanced UI features. It does NOT require authentication
 * (same security model as the main upload endpoint).
 *
 * For now, we just accept and discard this data since we don't use it,
 * but we must accept it or go-tfe's Upload function will fail.
 */
stateUploadRoute.put("/state-versions/:state_version_id/upload-json/:upload_token", async (c) => {
  const rateLimitResponse = enforceRateLimit(c, STATE_UPLOAD_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  const svId = c.req.param("state_version_id")
  const uploadToken = c.req.param("upload_token")

  log.info("JSON state upload request received (unauthenticated)", {
    stateVersionId: svId,
    contentType: c.req.header("content-type"),
    contentLength: c.req.header("content-length"),
  })

  const sv = await findStateVersionById(svId)
  if (!sv) {
    log.warn("JSON state upload failed: state version not found", { stateVersionId: svId })
    return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
  }
  if (!stateUploadTokenMatches(sv, uploadToken)) {
    log.warn("JSON state upload failed: invalid upload capability", {
      stateVersionId: svId,
      reason: "upload_capability_mismatch",
    })
    return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
  }

  if (sv.status === "pending") {
    const pendingResponse = await ensurePendingUploadIsUsable(sv)
    if (pendingResponse) {
      return pendingResponse
    }
  } else if (sv.status === "finalized") {
    if (sv.runId && sv.jobId) {
      const workspace = await findWorkspaceById(sv.workspaceId)
      const capability = workspace
        ? await resolveActiveRunCapability({
            runId: sv.runId,
            jobId: sv.jobId,
            workspaceId: sv.workspaceId,
            orgId: workspace.orgId,
          })
        : null
      if (!capability) {
        return getPendingUploadExpiryResponse()
      }
    }
  } else {
    return c.json({ errors: [{ status: "409", title: "State upload is closed" }] }, 409)
  }

  // Read and discard the body - we don't currently use the JSON state
  // but must accept it for go-tfe's Upload function to succeed
  let body: Uint8Array
  try {
    body = await readRequestBodyBytes(c.req.raw, JSON_STATE_UPLOAD_MAX_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return c.json({ errors: [{ status: "413", title: "JSON state upload too large" }] }, 413)
    }
    throw err
  }
  const size = body.byteLength
  if (
    !sv.uploadTokenHash ||
    !(await completeJsonStateUpload(
      sv,
      sv.uploadTokenHash,
      sv.runId && sv.jobId ? { runId: sv.runId, jobId: sv.jobId } : undefined,
    ))
  ) {
    return c.json({ errors: [{ status: "409", title: "State upload is closed" }] }, 409)
  }

  log.info("JSON state upload accepted (discarded)", {
    stateVersionId: svId,
    size,
  })

  // Return 200 OK with empty body (mimicking S3 PUT response)
  return c.body(null, 200)
})
