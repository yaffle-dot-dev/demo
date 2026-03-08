import type { Context, Next } from "hono"
import { requireAuth, AuthError, type AuthContext } from "../lib/auth.ts"
import { getMembershipRole } from "../db/queries/users.ts"
import { findOrgBySlug } from "../db/queries/organizations.ts"
import { getEnv } from "../lib/env.ts"

/**
 * Extended auth context with resolved org access
 */
export interface OrgAuthContext extends AuthContext {
  orgId: string
  role: string
}

// Minimum role hierarchy for permission checks
const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1,
  approver: 2,
  admin: 3,
}

function hasMinRole(userRole: string, requiredRole: string): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] ?? 0
  const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? 0
  return userLevel >= requiredLevel
}

export interface OrgAuthOptions {
  /** Minimum role required (defaults to "viewer") */
  minRole?: "viewer" | "approver" | "admin"
  /** How to get the org identifier - either from query param or route param */
  orgSource?: "query" | "param"
  /** Name of the query param or route param containing the org (defaults to "org") */
  orgKey?: string
  /** For SSE endpoints - allow token in query param */
  allowQueryToken?: boolean
}

/**
 * Middleware factory that requires authentication AND org membership.
 *
 * Usage:
 * ```ts
 * // Require viewer access to org from ?org= query param
 * route.get("/", requireOrgAccess(), handler)
 *
 * // Require admin access to org from :org route param
 * route.post("/:org/settings", requireOrgAccess({ minRole: "admin", orgSource: "param" }), handler)
 *
 * // SSE endpoint with token in query
 * route.get("/stream", requireOrgAccess({ allowQueryToken: true }), handler)
 * ```
 */
export function requireOrgAccess(options: OrgAuthOptions = {}) {
  const {
    minRole = "viewer",
    orgSource = "query",
    orgKey = "org",
    allowQueryToken = false,
  } = options

  return async (c: Context, next: Next) => {
    const env = getEnv()

    // Get token from query if allowed (for SSE)
    const queryToken = allowQueryToken ? c.req.query("token") : undefined

    // Authenticate the user
    let auth: AuthContext
    try {
      auth = await requireAuth(c.req.raw.headers, { token: queryToken })
    } catch (err) {
      if (err instanceof AuthError) {
        const status = err.code === "AUTH_REQUIRED" ? 401 : 403
        return c.json({ error: { code: err.code, message: err.message } }, status)
      }
      throw err
    }

    // Get org identifier
    const orgSlug = orgSource === "query" ? c.req.query(orgKey) : c.req.param(orgKey)
    if (!orgSlug) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: `${orgKey} is required` } },
        400,
      )
    }

    // Resolve org
    const org = await findOrgBySlug(orgSlug)
    if (!org) {
      return c.json(
        { error: { code: "ORG_NOT_FOUND", message: `organization not found: ${orgSlug}` } },
        404,
      )
    }

    // Check membership and role
    let role: string
    if (env.authMode === "dev" && auth.orgId && auth.role) {
      // Dev mode with headers - use provided org/role
      if (auth.orgId !== org.id) {
        return c.json({ error: { code: "FORBIDDEN", message: "org access denied" } }, 403)
      }
      role = auth.role
    } else {
      // Production mode - check membership in DB
      const memberRole = await getMembershipRole({ orgId: org.id, userId: auth.userId })
      if (!memberRole) {
        return c.json({ error: { code: "FORBIDDEN", message: "org access denied" } }, 403)
      }
      role = memberRole
    }

    // Check minimum role
    if (!hasMinRole(role, minRole)) {
      return c.json(
        { error: { code: "FORBIDDEN", message: `requires ${minRole} role or higher` } },
        403,
      )
    }

    // Set enriched auth context for handler
    const orgAuth: OrgAuthContext = {
      ...auth,
      orgId: org.id,
      role,
    }
    c.set("auth", orgAuth)

    await next()
  }
}

/**
 * Middleware factory for routes that access resources by ID (preview, run, etc.)
 * where the org is resolved from the resource itself.
 *
 * Usage:
 * ```ts
 * // The handler must set c.set("resourceOrgId", preview.orgId) before this runs,
 * // OR use a pre-fetch middleware that loads the resource first.
 * route.get("/:id", loadPreview(), requireResourceAccess(), handler)
 * ```
 */
export interface ResourceAuthOptions {
  /** Minimum role required (defaults to "viewer") */
  minRole?: "viewer" | "approver" | "admin"
  /** For SSE endpoints - allow token in query param */
  allowQueryToken?: boolean
  /** Function to get org ID from context - receives the Hono context */
  getOrgId: (c: Context) => Promise<string | null>
}

export function requireResourceAccess(options: ResourceAuthOptions) {
  const { minRole = "viewer", allowQueryToken = false, getOrgId } = options

  return async (c: Context, next: Next) => {
    const env = getEnv()

    // Resolve org ID from resource
    const orgId = await getOrgId(c)
    if (!orgId) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "resource not found" } },
        404,
      )
    }

    // Get token from query if allowed (for SSE)
    const queryToken = allowQueryToken ? c.req.query("token") : undefined

    // Authenticate the user
    let auth: AuthContext
    try {
      auth = await requireAuth(c.req.raw.headers, { token: queryToken })
    } catch (err) {
      if (err instanceof AuthError) {
        const status = err.code === "AUTH_REQUIRED" ? 401 : 403
        return c.json({ error: { code: err.code, message: err.message } }, status)
      }
      throw err
    }

    // Check membership and role
    let role: string
    if (env.authMode === "dev" && auth.orgId && auth.role) {
      if (auth.orgId !== orgId) {
        return c.json({ error: { code: "FORBIDDEN", message: "org access denied" } }, 403)
      }
      role = auth.role
    } else {
      const memberRole = await getMembershipRole({ orgId, userId: auth.userId })
      if (!memberRole) {
        return c.json({ error: { code: "FORBIDDEN", message: "org access denied" } }, 403)
      }
      role = memberRole
    }

    // Check minimum role
    if (!hasMinRole(role, minRole)) {
      return c.json(
        { error: { code: "FORBIDDEN", message: `requires ${minRole} role or higher` } },
        403,
      )
    }

    // Set enriched auth context for handler
    const orgAuth: OrgAuthContext = {
      ...auth,
      orgId,
      role,
    }
    c.set("auth", orgAuth)

    await next()
  }
}

/**
 * Helper to get typed auth context from Hono context
 */
export function getAuth(c: Context): OrgAuthContext {
  return c.get("auth") as OrgAuthContext
}
