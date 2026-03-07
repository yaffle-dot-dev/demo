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
    result.attributes["hosted-state-upload-url"] = `/tfc/api/v2/state-versions/${sv.id}/upload`
  }

  if (options.includeDownloadUrl && sv.status === "finalized") {
    result.attributes["hosted-state-download-url"] = `/tfc/api/v2/state-versions/${sv.id}/download`
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

    // Check serial is greater than current
    const latest = await getLatestStateVersion(wsId)
    if (latest && attrs.serial <= latest.serial) {
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

    log.info("State version created (pending upload)", {
      stateVersionId: sv.id,
      workspaceId: wsId,
      serial: attrs.serial,
    })

    return c.json({ data: toJsonApiStateVersion(sv, { includeUploadUrl: true }) }, 201)
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

    const sv = await findStateVersionById(svId)
    if (!sv) {
      return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
    }

    return c.json({
      data: toJsonApiStateVersion(sv, {
        includeUploadUrl: sv.status === "pending",
        includeDownloadUrl: sv.status === "finalized",
      }),
    })
  },
)

/**
 * PUT /tfc/api/v2/state-versions/:state_version_id/upload
 * Upload state content (phase 2 of two-phase upload).
 */
stateVersionsRoute.put(
  "/state-versions/:state_version_id/upload",
  requireScopes("state:write"),
  async (c) => {
    const svId = c.req.param("state_version_id")
    const auth = c.get("tfcAuth")

    const sv = await findStateVersionById(svId)
    if (!sv) {
      return c.json({ errors: [{ status: "404", title: "State version not found" }] }, 404)
    }

    // Must be pending
    if (sv.status !== "pending") {
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

    // Check workspace access
    if (auth.type === "run" && auth.workspaceId !== sv.workspaceId) {
      return c.json(
        { errors: [{ status: "403", title: "Token not authorized for this workspace" }] },
        403,
      )
    }

    // Read body as bytes
    const body = await c.req.arrayBuffer()
    const content = new Uint8Array(body)

    // Upload to S3, validating MD5
    try {
      const { size, md5 } = await uploadState(sv.s3Key, content, sv.md5)

      // Verify size matches if we want (MD5 is the main integrity check)
      if (md5 !== sv.md5) {
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
      })

      return c.body(null, 200)
    } catch (err) {
      if (err instanceof StateUploadError) {
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
