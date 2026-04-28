import type { Context, MiddlewareHandler } from "hono"

import { findAnonymousSessionById, touchPrincipalSession } from "../db/queries/principals.ts"
import { verifyAnonymousSessionToken } from "../lib/principal-tokens.ts"

export interface PrincipalAuthContext {
  type: "anonymous_session"
  principalId: string
  sessionId: string
}

function extractBearerToken(c: Context): string | null {
  const authHeader = c.req.header("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }
  return authHeader.slice(7)
}

export function principalAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearerToken(c)
    if (!token) {
      return c.json({ error: { code: "AUTH_REQUIRED", message: "authentication required" } }, 401)
    }

    const payload = await verifyAnonymousSessionToken(token)
    if (!payload) {
      return c.json({ error: { code: "INVALID_TOKEN", message: "invalid token" } }, 401)
    }

    const record = await findAnonymousSessionById(payload.session_id)
    if (!record || record.principal.id !== payload.principal_id) {
      return c.json({ error: { code: "INVALID_TOKEN", message: "invalid token" } }, 401)
    }

    if (record.principal.status !== "active" || record.session.status !== "active") {
      return c.json({ error: { code: "SESSION_INACTIVE", message: "session is not active" } }, 401)
    }

    if (record.session.expiresAt && record.session.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: { code: "SESSION_EXPIRED", message: "session has expired" } }, 401)
    }

    await touchPrincipalSession(record.principal.id, record.session.id)

    c.set("principalAuth", {
      type: "anonymous_session",
      principalId: record.principal.id,
      sessionId: record.session.id,
    } as PrincipalAuthContext)

    return next()
  }
}
