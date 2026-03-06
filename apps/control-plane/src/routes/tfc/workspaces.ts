import { Hono } from "hono"
import { z } from "zod"

import { logger as log } from "../../lib/telemetry.ts"
import { findOrgBySlug } from "../../db/queries/organizations.ts"
import {
  findWorkspaceById,
  findWorkspaceByName,
  listWorkspaces,
  createWorkspace,
  lockWorkspace,
  unlockWorkspace,
  forceUnlockWorkspace,
  type Workspace,
} from "../../db/queries/workspaces.ts"
import {
  tfcAuth,
  requireScopes,
  type TfcAuthContext,
} from "../../middleware/tfc-auth.ts"

// Hono context variables for TFC auth
type TfcVariables = {
  tfcAuth: TfcAuthContext
  tfcOrgId: string
  tfcRole: string
}

/**
 * TFC-compatible workspace API.
 * Implements endpoints under /tfc/api/v2/workspaces and /tfc/api/v2/organizations/:org/workspaces
 */
export const workspacesRoute = new Hono<{ Variables: TfcVariables }>()

// All routes require TFC authentication
workspacesRoute.use("*", tfcAuth())

// =============================================================================
// JSON:API Response Helpers
// =============================================================================

interface JsonApiWorkspace {
  id: string
  type: "workspaces"
  attributes: {
    name: string
    locked: boolean
    "locked-by"?: string | null
    "locked-at"?: string | null
    "locked-reason"?: string | null
    "terraform-version"?: string | null
    environment: string
    "created-at": string
  }
  relationships?: {
    organization?: {
      data: { id: string; type: "organizations" }
    }
    "current-state-version"?: {
      data: { id: string; type: "state-versions" } | null
    }
  }
}

function toJsonApiWorkspace(ws: Workspace): JsonApiWorkspace {
  return {
    id: ws.id,
    type: "workspaces",
    attributes: {
      name: ws.name,
      locked: ws.locked,
      "locked-by": ws.lockedBy,
      "locked-at": ws.lockedAt?.toISOString() ?? null,
      "locked-reason": ws.lockReason,
      "terraform-version": ws.terraformVersion,
      environment: ws.environment,
      "created-at": ws.createdAt.toISOString(),
    },
    relationships: {
      organization: {
        data: { id: ws.orgId, type: "organizations" },
      },
      "current-state-version": ws.currentStateVersionId
        ? { data: { id: ws.currentStateVersionId, type: "state-versions" } }
        : { data: null },
    },
  }
}

// =============================================================================
// Organization-scoped routes (/organizations/:org_name/workspaces)
// =============================================================================

/**
 * GET /tfc/api/v2/organizations/:org_name/workspaces
 * List workspaces in an organization.
 */
workspacesRoute.get(
  "/organizations/:org_name/workspaces",
  async (c) => {
    const orgName = c.req.param("org_name")

    // Find org by slug
    const org = await findOrgBySlug(orgName)
    if (!org) {
      return c.json({ errors: [{ status: "404", title: "Organization not found" }] }, 404)
    }

    // Check org membership
    const auth = c.get("tfcAuth") as TfcAuthContext
    if (auth.type === "run" && auth.orgId !== org.id) {
      return c.json({ errors: [{ status: "403", title: "Token not authorized for this organization" }] }, 403)
    }
    // TODO: Check user membership for user tokens

    // Parse query params for filtering
    const searchParams = new URL(c.req.url).searchParams
    const { items, nextCursor } = await listWorkspaces(org.id, {
      limit: parseInt(searchParams.get("page[size]") || "20", 10),
      cursor: searchParams.get("page[after]") || undefined,
    })

    return c.json({
      data: items.map(toJsonApiWorkspace),
      meta: {
        pagination: {
          "next-page": nextCursor,
        },
      },
    })
  },
)

/**
 * GET /tfc/api/v2/organizations/:org_name/workspaces/:name
 * Get a workspace by name.
 */
workspacesRoute.get(
  "/organizations/:org_name/workspaces/:name",
  async (c) => {
    const orgName = c.req.param("org_name")
    const wsName = c.req.param("name")

    const org = await findOrgBySlug(orgName)
    if (!org) {
      return c.json({ errors: [{ status: "404", title: "Organization not found" }] }, 404)
    }

    const ws = await findWorkspaceByName(org.id, wsName)
    if (!ws) {
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    return c.json({ data: toJsonApiWorkspace(ws) })
  },
)

/**
 * POST /tfc/api/v2/organizations/:org_name/workspaces
 * Create a workspace.
 */
workspacesRoute.post(
  "/organizations/:org_name/workspaces",
  async (c) => {
    const orgName = c.req.param("org_name")

    const org = await findOrgBySlug(orgName)
    if (!org) {
      return c.json({ errors: [{ status: "404", title: "Organization not found" }] }, 404)
    }

    // Parse request body
    const body = await c.req.json()
    const schema = z.object({
      data: z.object({
        type: z.literal("workspaces"),
        attributes: z.object({
          name: z.string().min(1).max(90),
          repo: z.string().optional(),
          "workspace-path": z.string().optional(),
          environment: z.enum(["preview", "production"]).optional(),
          branch: z.string().optional(),
          "pr-number": z.number().optional(),
          "terraform-version": z.string().optional(),
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

    // Check if workspace already exists
    const existing = await findWorkspaceByName(org.id, attrs.name)
    if (existing) {
      return c.json(
        { errors: [{ status: "409", title: "Workspace already exists" }] },
        409,
      )
    }

    const ws = await createWorkspace({
      orgId: org.id,
      name: attrs.name,
      repo: attrs.repo ?? "",
      workspacePath: attrs["workspace-path"] ?? "",
      environment: attrs.environment ?? "preview",
      branch: attrs.branch ?? "main",
      prNumber: attrs["pr-number"],
      terraformVersion: attrs["terraform-version"],
    })

    log.info("Workspace created", { workspaceId: ws.id, name: ws.name, orgId: org.id })

    return c.json({ data: toJsonApiWorkspace(ws) }, 201)
  },
)

// =============================================================================
// Workspace-scoped routes (/workspaces/:workspace_id)
// =============================================================================

/**
 * GET /tfc/api/v2/workspaces/:workspace_id
 * Get a workspace by ID.
 */
workspacesRoute.get(
  "/workspaces/:workspace_id",
  async (c) => {
    const wsId = c.req.param("workspace_id")

    const ws = await findWorkspaceById(wsId)
    if (!ws) {
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    return c.json({ data: toJsonApiWorkspace(ws) })
  },
)

/**
 * POST /tfc/api/v2/workspaces/:workspace_id/actions/lock
 * Lock a workspace.
 */
workspacesRoute.post(
  "/workspaces/:workspace_id/actions/lock",
  requireScopes("workspace:lock"),
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const auth = c.get("tfcAuth") as TfcAuthContext

    const ws = await findWorkspaceById(wsId)
    if (!ws) {
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    // Check workspace access for run tokens
    if (auth.type === "run" && auth.workspaceId !== ws.id) {
      return c.json({ errors: [{ status: "403", title: "Token not authorized for this workspace" }] }, 403)
    }

    // Parse optional lock reason
    let reason: string | undefined
    try {
      const body = await c.req.json()
      reason = body.reason
    } catch {
      // No body or invalid JSON is fine
    }

    // Determine lock owner
    const lockedBy = auth.type === "run" ? `run:${auth.runId}` : `user:${auth.userId}`

    const locked = await lockWorkspace(wsId, lockedBy, reason)
    if (!locked) {
      // Workspace is already locked
      const current = await findWorkspaceById(wsId)
      return c.json(
        {
          errors: [
            {
              status: "409",
              title: "Workspace is locked",
              detail: `Locked by ${current?.lockedBy} at ${current?.lockedAt?.toISOString()}`,
            },
          ],
        },
        409,
      )
    }

    log.info("Workspace locked", { workspaceId: wsId, lockedBy })
    return c.json({ data: toJsonApiWorkspace(locked) })
  },
)

/**
 * POST /tfc/api/v2/workspaces/:workspace_id/actions/unlock
 * Unlock a workspace (only lock holder can unlock).
 */
workspacesRoute.post(
  "/workspaces/:workspace_id/actions/unlock",
  requireScopes("workspace:lock"),
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const auth = c.get("tfcAuth") as TfcAuthContext

    const ws = await findWorkspaceById(wsId)
    if (!ws) {
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    if (!ws.locked) {
      return c.json(
        { errors: [{ status: "409", title: "Workspace is not locked" }] },
        409,
      )
    }

    // Determine expected lock owner
    const lockedBy = auth.type === "run" ? `run:${auth.runId}` : `user:${auth.userId}`

    const unlocked = await unlockWorkspace(wsId, lockedBy)
    if (!unlocked) {
      return c.json(
        {
          errors: [
            {
              status: "409",
              title: "Cannot unlock workspace",
              detail: `Workspace is locked by ${ws.lockedBy}, not ${lockedBy}`,
            },
          ],
        },
        409,
      )
    }

    log.info("Workspace unlocked", { workspaceId: wsId, unlockedBy: lockedBy })
    return c.json({ data: toJsonApiWorkspace(unlocked) })
  },
)

/**
 * POST /tfc/api/v2/workspaces/:workspace_id/actions/force-unlock
 * Force unlock a workspace (requires admin permission).
 */
workspacesRoute.post(
  "/workspaces/:workspace_id/actions/force-unlock",
  async (c) => {
    const wsId = c.req.param("workspace_id")
    const auth = c.get("tfcAuth") as TfcAuthContext

    // Force unlock requires user token (not run tokens)
    if (auth.type === "run") {
      return c.json(
        { errors: [{ status: "403", title: "Force unlock requires user authentication" }] },
        403,
      )
    }

    const ws = await findWorkspaceById(wsId)
    if (!ws) {
      return c.json({ errors: [{ status: "404", title: "Workspace not found" }] }, 404)
    }

    // TODO: Check user has admin role on the org
    // For now, any authenticated user can force unlock

    if (!ws.locked) {
      return c.json(
        { errors: [{ status: "409", title: "Workspace is not locked" }] },
        409,
      )
    }

    const previousOwner = ws.lockedBy
    const unlocked = await forceUnlockWorkspace(wsId)
    if (!unlocked) {
      return c.json(
        { errors: [{ status: "500", title: "Failed to force unlock workspace" }] },
        500,
      )
    }

    log.info("Workspace force unlocked", {
      workspaceId: wsId,
      previousOwner: previousOwner ?? "unknown",
      forcedBy: `user:${auth.userId}`,
    })

    return c.json({ data: toJsonApiWorkspace(unlocked) })
  },
)
