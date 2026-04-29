import type { Context, MiddlewareHandler } from "hono"

import type { StateVersion } from "../db/queries/state-versions.ts"
import type { Workspace } from "../db/queries/workspaces.ts"

import { logger as log } from "../lib/telemetry.ts"
import { findApiTokenByHash, hashToken, touchApiToken } from "../db/queries/api-tokens.ts"
import { findOrgMembership } from "../db/queries/organizations.ts"
import {
  findAnonymousSessionById,
  findPrincipalById,
  findPrincipalRepoBindingById,
  touchPrincipalActivity,
} from "../db/queries/principals.ts"
import { findStateVersionById } from "../db/queries/state-versions.ts"
import { findWorkspaceById, findWorkspaceByLockId } from "../db/queries/workspaces.ts"
import { verifyExecutionToken } from "../lib/principal-tokens.ts"
import { verifyRunToken } from "../lib/run-token.ts"

// Re-export for convenience
export { generateRunToken, type RunTokenPayload } from "../lib/run-token.ts"

/**
 * TFC authentication context attached to requests.
 */
export interface TfcAuthContext {
  type: "user" | "run" | "execution"
  userId?: string // Present for user tokens
  runId?: string // Present for run tokens
  workspaceId?: string // Present for run tokens (scoped access)
  orgId?: string // Present for run tokens and org-scoped user tokens
  scopes: string[] // e.g., ["state:read", "state:write", "workspace:lock"]
  tokenId?: string
  principalId?: string
  sessionId?: string
  repoBindingId?: string
  repoNamespace?: string
  environmentName?: string
  consumerWorkspacePath?: string
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

    const executionPayload = await verifyExecutionToken(token)
    if (executionPayload) {
      const binding = await findPrincipalRepoBindingById(executionPayload.repo_binding_id)
      if (!binding || binding.principalId !== executionPayload.principal_id) {
        return c.json(
          { errors: [{ status: "401", title: "Invalid token" }] },
          401,
        )
      }

      if (executionPayload.session_id) {
        const record = await findAnonymousSessionById(executionPayload.session_id)
        if (!record || record.principal.id !== executionPayload.principal_id) {
          return c.json(
            { errors: [{ status: "401", title: "Invalid token" }] },
            401,
          )
        }

        if (record.principal.status !== "active" || record.session.status !== "active") {
          return c.json(
            { errors: [{ status: "401", title: "Invalid token" }] },
            401,
          )
        }

        if (record.session.expiresAt && record.session.expiresAt.getTime() <= Date.now()) {
          return c.json(
            { errors: [{ status: "401", title: "Invalid token" }] },
            401,
          )
        }

        await touchPrincipalActivity({
          principalId: record.principal.id,
          sessionId: record.session.id,
          repoBindingId: binding.id,
        })
      } else {
        const principal = await findPrincipalById(executionPayload.principal_id)
        if (!principal || principal.status !== "active") {
          return c.json(
            { errors: [{ status: "401", title: "Invalid token" }] },
            401,
          )
        }

        await touchPrincipalActivity({
          principalId: principal.id,
          repoBindingId: binding.id,
        })
      }

      c.set("tfcAuth", {
        type: "execution",
        principalId: executionPayload.principal_id,
        sessionId: executionPayload.session_id,
        repoBindingId: executionPayload.repo_binding_id,
        repoNamespace: executionPayload.canonical_repo_namespace,
        environmentName: executionPayload.environment_name,
        consumerWorkspacePath: executionPayload.consumer_workspace_path,
        scopes: executionPayload.scopes,
      } as TfcAuthContext)

      log.debug("Execution token authenticated", {
        principalId: executionPayload.principal_id,
        sessionId: executionPayload.session_id,
        repoBindingId: executionPayload.repo_binding_id,
        environmentName: executionPayload.environment_name,
        consumerWorkspacePath: executionPayload.consumer_workspace_path,
      })
      return next()
    }

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
  workspaceIdentifier: string,
  minRole: TfcRole = "viewer",
  options?: { allowLockId?: boolean },
): Promise<TfcWorkspaceAccess | Response> {
  const workspaceById = UUID_PATTERN.test(workspaceIdentifier)
    ? await findWorkspaceById(workspaceIdentifier)
    : undefined
  const workspace =
    workspaceById ??
    (options?.allowLockId ? await findWorkspaceByLockId(workspaceIdentifier) : undefined)

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
