import type { Context, MiddlewareHandler } from "hono"

import type { StateVersion } from "../db/queries/state-versions.ts"
import type { Workspace } from "../db/queries/workspaces.ts"

import { logger as log } from "../lib/telemetry.ts"
import { findApiTokenByHash, hashToken, touchApiToken } from "../db/queries/api-tokens.ts"
import { findOrgMembership } from "../db/queries/organizations.ts"
import { findStateVersionById } from "../db/queries/state-versions.ts"
import { findWorkspaceById } from "../db/queries/workspaces.ts"
import { verifyRunToken } from "../lib/run-token.ts"

// Re-export for convenience
export { generateRunToken, type RunTokenPayload } from "../lib/run-token.ts"

/**
 * TFC authentication context attached to requests.
 */
export interface TfcAuthContext {
  type: "user" | "run"
  userId?: string // Present for user tokens
  runId?: string // Present for run tokens
  workspaceId?: string // Present for run tokens (scoped access)
  orgId?: string // Present for run tokens and org-scoped user tokens
  scopes: string[] // e.g., ["state:read", "state:write", "workspace:lock"]
  tokenId?: string
}

export type TfcRole = "viewer" | "approver" | "admin"

export interface TfcOrgAccess {
  auth: TfcAuthContext
  orgId: string
  role?: TfcRole
}

export interface TfcWorkspaceAccess extends TfcOrgAccess {
  workspace: Workspace
}

export interface TfcStateVersionAccess extends TfcWorkspaceAccess {
  stateVersion: StateVersion
}

const ROLE_HIERARCHY: Record<TfcRole, number> = {
  viewer: 0,
  approver: 1,
  admin: 2,
}

function jsonApiError(status: number, title: string, detail?: string): Response {
  return Response.json(
    {
      errors: [
        {
          status: String(status),
          title,
          ...(detail ? { detail } : {}),
        },
      ],
    },
    { status },
  )
}

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(c: Context): string | null {
  const authHeader = c.req.header("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }
  return authHeader.slice(7)
}

/**
 * TFC authentication middleware.
 *
 * Validates Bearer tokens from Authorization header.
 * Supports both:
 * - User API tokens (from terraform login) - opaque tokens, SHA-256 hashed in DB
 * - Run tokens (JWTs for automated runs) - stateless verification
 *
 * Sets `tfcAuth` variable on the context.
 */
export function tfcAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearerToken(c)

    if (!token) {
      return c.json(
        { errors: [{ status: "401", title: "Authentication required" }] },
        401,
      )
    }

    // Try JWT verification first (run tokens are JWTs)
    log.debug("TFC auth: attempting token verification", {
      tokenPrefix: token.slice(0, 20) + "...",
      tokenLength: token.length,
      looksLikeJwt: token.split(".").length === 3,
    })

    const runPayload = await verifyRunToken(token)
    if (runPayload) {
      const runId = runPayload.sub.replace("run:", "")

      // TODO: Optionally verify run is still active in database
      // For now, we trust the JWT signature and expiry

      c.set("tfcAuth", {
        type: "run",
        runId,
        workspaceId: runPayload.workspace_id,
        orgId: runPayload.org_id,
        scopes: runPayload.scopes,
      } as TfcAuthContext)

      log.debug("Run token authenticated", { runId, workspaceId: runPayload.workspace_id })
      return next()
    }

    // Not a JWT - try as API token (opaque)
    log.debug("TFC auth: JWT verification failed, trying API token")
    const tokenHash = hashToken(token)
    const apiToken = await findApiTokenByHash(tokenHash)

    if (!apiToken) {
      log.warn("TFC auth: token verification failed", {
        tokenPrefix: token.slice(0, 20) + "...",
        tokenHash: tokenHash.slice(0, 16) + "...",
      })
      return c.json(
        { errors: [{ status: "401", title: "Invalid token" }] },
        401,
      )
    }

    // Update last used timestamp (fire and forget)
    touchApiToken(apiToken.id).catch((err) =>
      log.warn("Failed to update token last_used_at", { error: String(err) }),
    )

    c.set("tfcAuth", {
      type: "user",
      userId: apiToken.userId,
      orgId: apiToken.orgId ?? undefined,
      scopes: apiToken.scopes,
      tokenId: apiToken.id,
    } as TfcAuthContext)

    if (!apiToken.orgId || apiToken.scopes.length === 0) {
      log.warn("TFC auth: rejecting legacy or unscoped API token", {
        tokenId: apiToken.id,
        userId: apiToken.userId,
      })
      return c.json(
        {
          errors: [
            {
              status: "401",
              title: "Token must be rotated",
              detail: "This Terraform token is missing org scope or scopes",
            },
          ],
        },
        401,
      )
    }

    log.debug("API token authenticated", { userId: apiToken.userId })
    return next()
  }
}

/**
 * Require specific scopes for an endpoint.
 */
export function requireScopes(...requiredScopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("tfcAuth") as TfcAuthContext | undefined

    if (!auth) {
      return c.json(
        { errors: [{ status: "401", title: "Authentication required" }] },
        401,
      )
    }

    // Check if all required scopes are present
    const missingScopes = requiredScopes.filter((s) => !auth.scopes.includes(s))
    if (missingScopes.length > 0) {
      return c.json(
        {
          errors: [
            {
              status: "403",
              title: "Insufficient permissions",
              detail: `Missing scopes: ${missingScopes.join(", ")}`,
            },
          ],
        },
        403,
      )
    }

    return next()
  }
}

/**
 * Require org membership for user tokens.
 * Run tokens are already scoped to a specific org/workspace.
 */
export function requireOrgMembership(
  getOrgId: (c: Context) => string | Promise<string>,
  minRole: TfcRole = "viewer",
): MiddlewareHandler {
  return async (c, next) => {
    const orgId = await getOrgId(c)

    const access = await authorizeOrgAccess(c, orgId, minRole)
    if (access instanceof Response) {
      return access
    }

    return next()
  }
}

/**
 * Require workspace access for run tokens.
 */
export function requireWorkspaceAccess(
  getWorkspaceId: (c: Context) => string | Promise<string>,
): MiddlewareHandler {
  return async (c, next) => {
    const workspaceId = await getWorkspaceId(c)

    const access = await getTfcWorkspaceAccess(c, workspaceId)
    if (access instanceof Response) {
      return access
    }

    return next()
  }
}

export async function authorizeOrgAccess(
  c: Context,
  orgId: string,
  minRole: TfcRole = "viewer",
): Promise<TfcOrgAccess | Response> {
  const auth = c.get("tfcAuth") as TfcAuthContext | undefined

  if (!auth) {
    return jsonApiError(401, "Authentication required")
  }

  if (auth.type === "run") {
    if (auth.orgId !== orgId) {
      return jsonApiError(403, "Token not authorized for this organization")
    }

    c.set("tfcOrgId", orgId)
    return { auth, orgId }
  }

  if (!auth.userId) {
    return jsonApiError(401, "User ID required")
  }

  if (auth.orgId !== orgId) {
    return jsonApiError(403, "Token not authorized for this organization")
  }

  const membership = await findOrgMembership(orgId, auth.userId)
  if (!membership) {
    return jsonApiError(403, "Not a member of this organization")
  }

  const role = membership.role as TfcRole
  const userRoleLevel = ROLE_HIERARCHY[role] ?? 0
  const requiredLevel = ROLE_HIERARCHY[minRole]

  if (userRoleLevel < requiredLevel) {
    return jsonApiError(403, "Insufficient role", `Required: ${minRole}, yours: ${membership.role}`)
  }

  c.set("tfcOrgId", orgId)
  c.set("tfcRole", membership.role)

  return {
    auth,
    orgId,
    role,
  }
}

export async function getTfcWorkspaceAccess(
  c: Context,
  workspaceId: string,
  minRole: TfcRole = "viewer",
): Promise<TfcWorkspaceAccess | Response> {
  const workspace = await findWorkspaceById(workspaceId)
  if (!workspace) {
    return jsonApiError(404, "Workspace not found")
  }

  const orgAccess = await authorizeOrgAccess(c, workspace.orgId, minRole)
  if (orgAccess instanceof Response) {
    return orgAccess
  }

  if (orgAccess.auth.type === "run" && orgAccess.auth.workspaceId !== workspace.id) {
    return jsonApiError(403, "Token not authorized for this workspace")
  }

  return {
    ...orgAccess,
    workspace,
  }
}

export async function getTfcStateVersionAccess(
  c: Context,
  stateVersionId: string,
  minRole: TfcRole = "viewer",
): Promise<TfcStateVersionAccess | Response> {
  const stateVersion = await findStateVersionById(stateVersionId)
  if (!stateVersion) {
    return jsonApiError(404, "State version not found")
  }

  const workspaceAccess = await getTfcWorkspaceAccess(c, stateVersion.workspaceId, minRole)
  if (workspaceAccess instanceof Response) {
    return workspaceAccess
  }

  return {
    ...workspaceAccess,
    stateVersion,
  }
}
