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
import { discardPendingStateVersions } from "../../db/queries/state-versions.ts"
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

/**
 * Workspace permissions - determines what operations the token can perform.
 * These map to go-tfe's WorkspacePermissions struct.
 */
interface WorkspacePermissions {
  "can-destroy": boolean
  "can-force-unlock": boolean
  "can-lock": boolean
  "can-manage-run-tasks": boolean
  "can-queue-apply": boolean
  "can-queue-destroy": boolean
  "can-queue-run": boolean
  "can-read-settings": boolean
  "can-unlock": boolean
  "can-update": boolean
  "can-update-variable": boolean
}

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
    // Additional fields required by Terraform/OpenTofu cloud backend
    "execution-mode": string
    "operations": boolean
    "permissions": WorkspacePermissions
    "auto-apply": boolean
    "speculative-enabled": boolean
    "structured-run-output-enabled": boolean
    "source"?: string
    "source-name"?: string
    "source-url"?: string
    "working-directory"?: string
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
      "terraform-version": ws.terraformVersion ?? "latest",
      environment: ws.environment,
      "created-at": ws.createdAt.toISOString(),
      // Yaffle uses local execution mode - plans run locally, state stored remotely
      "execution-mode": "local",
      // Enable operations (required for cloud backend)
      "operations": true,
      // Allow all operations - Yaffle manages auth via tokens
      "permissions": {
        "can-destroy": true,
        "can-force-unlock": true,
        "can-lock": true,
        "can-manage-run-tasks": false,
        "can-queue-apply": true,
        "can-queue-destroy": true,
        "can-queue-run": true,
        "can-read-settings": true,
        "can-unlock": true,
        "can-update": true,
        "can-update-variable": true,
      },
      "auto-apply": false,
      "speculative-enabled": true,
      "structured-run-output-enabled": true,
      "source": "yaffle",
      "source-name": "Yaffle",
      "source-url": "",
      "working-directory": "",
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
// Organization routes (/organizations/:org_name)
// =============================================================================

/**
 * GET /tfc/api/v2/organizations/:org_name
 * Get organization details. Required by Terraform cloud backend during init.
 */
workspacesRoute.get(
  "/organizations/:org_name",
  async (c) => {
    const orgName = c.req.param("org_name")

    const org = await findOrgBySlug(orgName)
    if (!org) {
      return c.json(
        { errors: [{ status: "404", title: `Organization "${orgName}" not found` }] },
        404,
      )
    }

    log.info("TFC: organization fetched", {
      "tfc.organization": orgName,
      "tfc.org_id": org.id,
    })

    // Return organization in TFE-compatible format
    return c.json({
      data: {
        id: org.slug,
        type: "organizations",
        attributes: {
          "external-id": org.id,
          "created-at": org.createdAt.toISOString(),
          "name": org.slug,
          "cost-estimation-enabled": false,
          "default-execution-mode": "local",
          "permissions": {
            "can-update": true,
            "can-destroy": false,
            "can-create-workspace": true,
            "can-traverse": true,
          },
        },
        relationships: {
          "entitlement-set": {
            data: { id: org.id, type: "entitlement-sets" },
            links: {
              related: `/api/v2/organizations/${org.slug}/entitlement-set`,
            },
          },
        },
        links: {
          self: `/api/v2/organizations/${org.slug}`,
        },
      },
    })
  },
)

/**
 * GET /tfc/api/v2/organizations/:org_name/entitlement-set
 * Get organization entitlements. Required by Terraform cloud backend during init.
 * We return a minimal set enabling all features.
 */
workspacesRoute.get(
  "/organizations/:org_name/entitlement-set",
  async (c) => {
    const orgName = c.req.param("org_name")

    const org = await findOrgBySlug(orgName)
    if (!org) {
      return c.json(
        { errors: [{ status: "404", title: `Organization "${orgName}" not found` }] },
        404,
      )
    }

    log.info("TFC: entitlement-set fetched", {
      "tfc.organization": orgName,
      "tfc.org_id": org.id,
    })

    // Return entitlements that enable state storage and the cloud backend
    // Based on TFE API docs sample response
    return c.json({
      data: {
        id: org.id,
        type: "entitlement-sets",
        attributes: {
          "agents": false,
          "audit-logging": false,
          "configuration-designer": true,
          "cost-estimation": false,
          "global-run-tasks": false,
          "module-tests-generation": false,
          "operations": true,
          "policy-enforcement": false,
          "policy-limit": null,
          "policy-mandatory-enforcement-limit": null,
          "policy-set-limit": null,
          "private-module-registry": true,
          "run-task-limit": null,
          "run-task-mandatory-enforcement-limit": null,
          "run-task-workspace-limit": null,
          "run-tasks": false,
          "self-serve-billing": true,
          "sentinel": false,
          "sso": false,
          "state-storage": true,
          "teams": false,
          "usage-reporting": false,
          "user-limit": null,
          "vcs-integrations": true,
          "versioned-policy-set-limit": null,
        },
        links: {
          self: `/api/v2/entitlement-sets/${org.id}`,
        },
      },
    })
  },
)

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

    const response = { data: toJsonApiWorkspace(ws) }
    
    // Always log key fields for debugging TFC compatibility
    log.info("TFC: workspace fetched by name", {
      "tfc.workspace": wsName,
      "tfc.workspace_id": ws.id,
      "tfc.execution_mode": response.data.attributes["execution-mode"],
      "tfc.operations": response.data.attributes.operations,
      "tfc.has_permissions": !!response.data.attributes.permissions,
      "tfc.permissions_can_queue_run": response.data.attributes.permissions?.["can-queue-run"],
    })
    // Debug: Log full response if YAFFLE_TFC_DEBUG env var is set
    if (process.env.YAFFLE_TFC_DEBUG) {
      log.info("TFC: workspace response JSON (by name)", {
        "tfc.response": JSON.stringify(response, null, 2),
      })
    }
    return c.json(response)
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
          environment: z.string().min(1).max(50).optional(),
          ref: z.string().optional(),
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
      ref: attrs.ref ?? "refs/heads/main",
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

    const response = { data: toJsonApiWorkspace(ws) }
    
    // Always log key fields for debugging TFC compatibility
    log.info("TFC: workspace fetched by ID", {
      "tfc.workspace_id": wsId,
      "tfc.workspace_name": ws.name,
      "tfc.execution_mode": response.data.attributes["execution-mode"],
      "tfc.operations": response.data.attributes.operations,
      "tfc.has_permissions": !!response.data.attributes.permissions,
      "tfc.permissions_can_queue_run": response.data.attributes.permissions?.["can-queue-run"],
    })
    // Debug: Log full response if YAFFLE_TFC_DEBUG env var is set
    if (process.env.YAFFLE_TFC_DEBUG) {
      log.info("TFC: workspace response JSON (by ID)", {
        "tfc.response": JSON.stringify(response, null, 2),
      })
    }
    return c.json(response)
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

    // Clean up any stale pending state versions from failed previous runs
    const discarded = await discardPendingStateVersions(wsId)
    if (discarded > 0) {
      log.info("Discarded stale pending state versions on lock", {
        workspaceId: wsId,
        discardedCount: discarded,
      })
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
