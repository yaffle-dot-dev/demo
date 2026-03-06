import type { Context, MiddlewareHandler } from "hono"

import { logger as log } from "../lib/telemetry.ts"
import { findApiTokenByHash, hashToken, touchApiToken } from "../db/queries/api-tokens.ts"
import { findOrgMembership } from "../db/queries/organizations.ts"
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
  orgId?: string // Present for run tokens
  scopes: string[] // e.g., ["state:read", "state:write", "workspace:lock"]
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
    const tokenHash = hashToken(token)
    const apiToken = await findApiTokenByHash(tokenHash)

    if (!apiToken) {
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
      scopes: ["*"], // User tokens have full access
    } as TfcAuthContext)

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

    // User tokens have full access
    if (auth.scopes.includes("*")) {
      return next()
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
  minRole: "viewer" | "approver" | "admin" = "viewer",
): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("tfcAuth") as TfcAuthContext | undefined

    if (!auth) {
      return c.json(
        { errors: [{ status: "401", title: "Authentication required" }] },
        401,
      )
    }

    const orgId = await getOrgId(c)

    // Run tokens are pre-scoped to an org
    if (auth.type === "run") {
      if (auth.orgId !== orgId) {
        return c.json(
          { errors: [{ status: "403", title: "Token not authorized for this organization" }] },
          403,
        )
      }
      return next()
    }

    // User tokens need membership check
    if (!auth.userId) {
      return c.json(
        { errors: [{ status: "401", title: "User ID required" }] },
        401,
      )
    }

    const membership = await findOrgMembership(orgId, auth.userId)
    if (!membership) {
      return c.json(
        { errors: [{ status: "403", title: "Not a member of this organization" }] },
        403,
      )
    }

    // Role hierarchy: admin > approver > viewer
    const roleHierarchy = { viewer: 0, approver: 1, admin: 2 }
    const userRoleLevel = roleHierarchy[membership.role as keyof typeof roleHierarchy] ?? 0
    const requiredLevel = roleHierarchy[minRole]

    if (userRoleLevel < requiredLevel) {
      return c.json(
        {
          errors: [
            {
              status: "403",
              title: "Insufficient role",
              detail: `Required: ${minRole}, yours: ${membership.role}`,
            },
          ],
        },
        403,
      )
    }

    // Attach org info to context
    c.set("tfcOrgId", orgId)
    c.set("tfcRole", membership.role)

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
    const auth = c.get("tfcAuth") as TfcAuthContext | undefined

    if (!auth) {
      return c.json(
        { errors: [{ status: "401", title: "Authentication required" }] },
        401,
      )
    }

    const workspaceId = await getWorkspaceId(c)

    // Run tokens are scoped to a specific workspace
    if (auth.type === "run" && auth.workspaceId !== workspaceId) {
      return c.json(
        { errors: [{ status: "403", title: "Token not authorized for this workspace" }] },
        403,
      )
    }

    // User tokens have access to all workspaces in their orgs
    // (org membership is checked separately)

    return next()
  }
}
