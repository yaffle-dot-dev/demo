import { getEnv } from "./env.ts"
import { auth, type Session } from "./better-auth.ts"
import {
  logger,
  withSpan,
  getAuthDurationHistogram,
  getAuthCounter,
  SpanStatusCode,
} from "./telemetry.ts"

export interface AuthContext {
  userId: string
  email: string
  name: string
  image: string | null
  orgId: string
  role: string
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "AuthError"
  }
}

/**
 * Get session from BetterAuth using request headers (cookies).
 */
async function getSession(headers: Headers): Promise<Session | null> {
  const start = Date.now()

  return withSpan("auth.getSession", async (span) => {
    try {
      const session = await auth.api.getSession({ headers })
      
      if (!session) {
        span.setAttributes({ "auth.session_found": false })
        getAuthCounter().add(1, { operation: "get_session", result: "no_session" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "get_session", result: "no_session" })
        return null
      }

      span.setAttributes({
        "auth.session_found": true,
        "auth.user_id": session.user.id,
        "auth.user_email": session.user.email,
      })

      getAuthCounter().add(1, { operation: "get_session", result: "success" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "get_session", result: "success" })

      return session
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      logger.error("session lookup error", { error: String(err) })
      getAuthCounter().add(1, { operation: "get_session", result: "error" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "get_session", result: "error" })
      return null
    }
  })
}

interface RequireAuthOptions {
  /** Token passed via query param (for SSE endpoints that can't use headers) */
  token?: string
}

/**
 * Require authentication for protected routes.
 * Uses BetterAuth session from cookies, or dev mode headers.
 */
export async function requireAuth(
  headers: Headers,
  options: RequireAuthOptions = {},
): Promise<AuthContext> {
  const start = Date.now()

  return withSpan("auth.requireAuth", async (span) => {
    const env = getEnv()

    // For SSE endpoints, token might be passed as query param
    // We need to construct a fake cookie header for BetterAuth
    if (options.token) {
      span.setAttributes({ "auth.method": "query_param" })
      // Create headers with the session token as a cookie
      const cookieHeaders = new Headers(headers)
      cookieHeaders.set("cookie", `better-auth.session_token=${options.token}`)
      
      const session = await getSession(cookieHeaders)
      if (session) {
        getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "query_param" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "query_param" })
        return {
          userId: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image ?? null,
          orgId: "",
          role: "",
        }
      }
    }

    // Try session from cookies
    const session = await getSession(headers)
    if (session) {
      span.setAttributes({
        "auth.method": "session",
        "auth.user_id": session.user.id,
        "auth.user_email": session.user.email,
      })

      getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "session" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "session" })

      return {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
        orgId: "",
        role: "",
      }
    }

    // Dev mode: accept special headers for testing
    if (env.authMode === "dev") {
      span.setAttributes({ "auth.method": "dev_headers" })
      const userId = headers.get("x-yaffle-user-id") ?? ""
      const email = headers.get("x-yaffle-user-email") ?? ""
      const name = headers.get("x-yaffle-user-name") ?? ""
      const orgId = headers.get("x-yaffle-org-id") ?? ""
      const role = headers.get("x-yaffle-role") ?? "viewer"

      if (!userId || !email) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "missing dev auth headers" })
        getAuthCounter().add(1, { operation: "require_auth", result: "missing_headers" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "missing_headers" })
        throw new AuthError("missing dev auth headers (x-yaffle-user-id, x-yaffle-user-email)", "MISSING_HEADERS")
      }

      span.setAttributes({
        "auth.user_id": userId,
        "auth.user_email": email,
        "auth.org_id": orgId,
        "auth.role": role,
      })

      getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "dev" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "dev" })

      return {
        userId,
        email,
        name,
        image: null,
        orgId,
        role,
      }
    }

    span.setStatus({ code: SpanStatusCode.ERROR, message: "no valid authentication provided" })
    getAuthCounter().add(1, { operation: "require_auth", result: "no_auth" })
    getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "no_auth" })
    throw new AuthError("no valid authentication provided", "AUTH_REQUIRED")
  })
}
