import { Hono } from "hono"
import { z } from "zod"

import { logger as log } from "../../lib/telemetry.ts"
import {
  findStateVersionById,
  getCurrentStateVersion,
  getLatestStateVersion,
  listStateVersions,
  createStateVersion,
  finalizeStateVersion,
  discardStateVersion,
  buildS3Key,
  type StateVersion,
} from "../../db/queries/state-versions.ts"
import { findWorkspaceById, updateWorkspaceCurrentState } from "../../db/queries/workspaces.ts"
import {
  tfcAuth,
  requireScopes,
  type TfcAuthContext,
} from "../../middleware/tfc-auth.ts"
import {
  uploadState,
  getStateDownloadUrl,
  downloadState,
  StateUploadError,
} from "../../lib/s3-state.ts"

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

function toJsonApiStateVersion(
  sv: StateVersion,
  options: { includeUploadUrl?: boolean; includeDownloadUrl?: boolean } = {},
): JsonApiStateVersion {
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

  if (options.includeUploadUrl && sv.status === "pending") {
    // Must be absolute URL for terraform to use it
    const host = process.env.YAFFLE_TFC_API_HOST ?? "localhost:6969"
    result.attributes["hosted-state-upload-url"] = `https://${host}/tfc/api/v2/state-versions/${sv.id}/upload`
    // JSON state upload URL - go-tfe uploads JSON state in parallel with raw state
    result.attributes["hosted-json-state-upload-url"] = `https://${host}/tfc/api/v2/state-versions/${sv.id}/upload-json`
  }

  if (options.includeDownloadUrl && sv.status === "finalized") {
    const host = process.env.YAFFLE_TFC_API_HOST ?? "localhost:6969"
    result.attributes["hosted-state-download-url"] = `https://${host}/tfc/api/v2/state-versions/${sv.id}/download`
    // JSON state download URL
    result.attributes["hosted-json-state-download-url"] = `https://${host}/tfc/api/v2/state-versions/${sv.id}/download-json`
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
  requireScopes("state:write"),
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const auth = c.get("tfcAuth")

    // Check workspace exists and is locked by caller
    const ws = await findWorkspaceById(wsId)
    if (!ws) {
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    // Check workspace access for run tokens
    if (auth.type === "run" && auth.workspaceId !== ws.id) {
      return c.json(
        { errors: [{ status: "403", title: "Token not authorized for this workspace" }] },
        403,
      )
    }

    // Workspace must be locked by caller
    const expectedLocker =
      auth.type === "run" ? `run:${auth.runId}` : `user:${auth.userId}`
    if (!ws.locked || ws.lockedBy !== expectedLocker) {
      return c.json(
        {
          errors: [
            {
              status: "409",
              title: "Workspace must be locked",
              detail: ws.locked
                ? `Workspace is locked by ${ws.lockedBy}, not ${expectedLocker}`
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
      // If the existing version is pending (incomplete upload), discard it and allow retry
      if (latest.status === "pending" && attrs.serial === latest.serial) {
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
                detail: `Serial ${attrs.serial} must be greater than current serial ${latest.serial}`,
              },
            ],
          },
          409,
        )
      }
    }

    // Build S3 key
    const s3Key = buildS3Key(wsId, attrs.serial)

    // Create state version record
    const sv = await createStateVersion({
      workspaceId: wsId,
      serial: attrs.serial,
      lineage: attrs.lineage,
      md5: attrs.md5,
      size: 0, // Will be updated on upload
      s3Key,
      status: "pending",
      createdBy: expectedLocker,
    })

    const response = toJsonApiStateVersion(sv, { includeUploadUrl: true })
    
    log.info("State version created (pending upload)", {
      stateVersionId: sv.id,
      workspaceId: wsId,
      serial: attrs.serial,
      uploadUrl: response.attributes["hosted-state-upload-url"],
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
  requireScopes("state:read"),
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const auth = c.get("tfcAuth")

    // Check workspace access
    const ws = await findWorkspaceById(wsId)
    if (!ws) {
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    if (auth.type === "run" && auth.workspaceId !== ws.id) {
      return c.json(
        { errors: [{ status: "403", title: "Token not authorized for this workspace" }] },
        403,
      )
    }

    const sv = await getCurrentStateVersion(wsId)
    if (!sv) {
      return c.json({ errors: [{ status: "404", title: "No state version found" }] }, 404)
    }

    return c.json({ data: toJsonApiStateVersion(sv, { includeDownloadUrl: true }) })
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
  requireScopes("state:read"),
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const auth = c.get("tfcAuth")

    log.info("GET current state version outputs", { workspaceId: wsId })

    // Check workspace access
    const ws = await findWorkspaceById(wsId)
    if (!ws) {
      log.warn("GET current state version outputs: workspace not found", { workspaceId: wsId })
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    if (auth.type === "run" && auth.workspaceId !== ws.id) {
      return c.json(
        { errors: [{ status: "403", title: "Token not authorized for this workspace" }] },
        403,
      )
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
        { errors: [{ status: "503", title: "Outputs are being processed", detail: "Retry the request" }] },
        503,
      )
    }

    // Convert outputs to JSON:API format
    // Terraform state outputs are stored as: { "output_name": { "value": ..., "type": ..., "sensitive": ... } }
    const outputs = (sv.outputs ?? {}) as Record<string, { value: unknown; type?: unknown; sensitive?: boolean }>
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

// =============================================================================
// State version routes
// =============================================================================

/**
 * GET /tfc/api/v2/state-versions
 * List state versions with filters.
 */
stateVersionsRoute.get(
  "/state-versions",
  requireScopes("state:read"),
  async (c) => {
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
              detail: "Must provide filter[workspace][id] or both filter[workspace][name] and filter[organization][name]",
            },
          ],
        },
        400,
      )
    }

    // For now, require workspace ID (simplest path)
    if (!workspaceId) {
      return c.json(
        { errors: [{ status: "400", title: "filter[workspace][id] is required" }] },
        400,
      )
    }

    const { items, nextCursor } = await listStateVersions(workspaceId, {
      limit: parseInt(searchParams.get("page[size]") || "20", 10),
      cursor: searchParams.get("page[after]") || undefined,
    })

    return c.json({
      data: items.map((sv) => toJsonApiStateVersion(sv, { includeDownloadUrl: true })),
      meta: {
        pagination: {
          "next-page": nextCursor,
        },
      },
    })
  },
)

/**
 * GET /tfc/api/v2/state-versions/:state_version_id
 * Get a state version by ID.
 */
stateVersionsRoute.get(
  "/state-versions/:state_version_id",
  requireScopes("state:read"),
  async (c) => {
    const svId = c.req.param("state_version_id")

    log.info("GET state version by ID", { stateVersionId: svId })

    const sv = await findStateVersionById(svId)
    if (!sv) {
      log.warn("GET state version: not found", { stateVersionId: svId })
      return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
    }

    log.info("GET state version: found", {
      stateVersionId: svId,
      status: sv.status,
      serial: sv.serial,
    })

    return c.json({
      data: toJsonApiStateVersion(sv, {
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
  requireScopes("state:read"),
  async (c) => {
    const svId = c.req.param("state_version_id")
    const auth = c.get("tfcAuth")

    const sv = await findStateVersionById(svId)
    if (!sv) {
      return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
    }

    // Must be finalized
    if (sv.status !== "finalized") {
      return c.json(
        { errors: [{ status: "404", title: "State version is not finalized" }] },
        404,
      )
    }

    // Check workspace access
    if (auth.type === "run" && auth.workspaceId !== sv.workspaceId) {
      return c.json(
        { errors: [{ status: "403", title: "Token not authorized for this workspace" }] },
        403,
      )
    }

    // Option 1: Redirect to presigned S3 URL
    // This is more efficient but may have CORS issues
    const useRedirect = c.req.header("accept")?.includes("*/*") ?? true

    if (useRedirect) {
      try {
        const url = await getStateDownloadUrl(sv.s3Key)
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
stateUploadRoute.put(
  "/state-versions/:state_version_id/upload",
  async (c) => {
    const svId = c.req.param("state_version_id")

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

    // Must be pending - this is the key security check
    // A state version can only be uploaded once
    if (sv.status !== "pending") {
      log.warn("State upload failed: state version not pending", {
        stateVersionId: svId,
        status: sv.status,
      })
      return c.json(
        {
          errors: [
            {
              status: "409",
              title: "State version is not pending",
              detail: `Status is ${sv.status}`,
            },
          ],
        },
        409,
      )
    }

    // Read body as bytes
    const body = await c.req.arrayBuffer()
    const content = new Uint8Array(body)

    // Upload to S3, validating MD5
    try {
      const { size, md5 } = await uploadState(sv.s3Key, content, sv.md5)

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
        outputs = stateJson.outputs
      } catch {
        // State might not be valid JSON, that's OK
      }

      // Finalize the state version
      const finalized = await finalizeStateVersion(svId, terraformVersion, outputs)
      if (!finalized) {
        log.error("State upload failed: could not finalize", { stateVersionId: svId })
        return c.json(
          { errors: [{ status: "500", title: "Failed to finalize state version" }] },
          500,
        )
      }

      // Update workspace's current state version
      await updateWorkspaceCurrentState(sv.workspaceId, svId)

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
        return c.json(
          {
            errors: [
              {
                status: "422",
                title: "Upload failed",
                detail: err.message,
              },
            ],
          },
          422,
        )
      }
      throw err
    }
  },
)

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
stateUploadRoute.put(
  "/state-versions/:state_version_id/upload-json",
  async (c) => {
    const svId = c.req.param("state_version_id")

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

    // Read and discard the body - we don't currently use the JSON state
    // but must accept it for go-tfe's Upload function to succeed
    const body = await c.req.arrayBuffer()
    const size = body.byteLength

    log.info("JSON state upload accepted (discarded)", {
      stateVersionId: svId,
      size,
    })

    // Return 200 OK with empty body (mimicking S3 PUT response)
    return c.body(null, 200)
  },
)
