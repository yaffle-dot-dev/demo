import type { Context, MiddlewareHandler } from "hono"

import {
  findAnonymousSessionById,
  findPrincipalById,
  touchPrincipalActivity,
  touchPrincipalSession,
} from "../db/queries/principals.ts"
import {
  verifyAccountPrincipalToken,
  verifyAnonymousSessionToken,
} from "../lib/principal-tokens.ts"

export interface PrincipalAuthContext {
  type: "anonymous_session" | "account"
  principalId: string
  sessionId?: string
  userId?: string
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

    const anonymousPayload = await verifyAnonymousSessionToken(token)
    if (anonymousPayload) {
      const record = await findAnonymousSessionById(anonymousPayload.session_id)
      if (!record || record.principal.id !== anonymousPayload.principal_id) {
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

    const accountPayload = await verifyAccountPrincipalToken(token)
    if (!accountPayload) {
      return c.json({ error: { code: "INVALID_TOKEN", message: "invalid token" } }, 401)
    }

    const principal = await findPrincipalById(accountPayload.principal_id)
    if (
      !principal
      || principal.type !== "account"
      || principal.status !== "active"
      || principal.userId !== accountPayload.user_id
    ) {
      return c.json({ error: { code: "INVALID_TOKEN", message: "invalid token" } }, 401)
    }

    await touchPrincipalActivity({ principalId: principal.id })

    c.set("principalAuth", {
      type: "account",
      principalId: principal.id,
      userId: accountPayload.user_id,
    } as PrincipalAuthContext)

    return next()
  }
}
