import { getEnv } from "./env.ts"
import { auth, type Session } from "./better-auth.ts"
import { db } from "./db.ts"
import { user } from "../db/auth-schema.ts"
import { eq } from "drizzle-orm"
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

/**
 * Verify API key and return user info.
 */
async function verifyApiKey(apiKey: string): Promise<AuthContext | null> {
  const start = Date.now()

  return withSpan("auth.verifyApiKey", async (span) => {
    try {
      const result = await auth.api.verifyApiKey({
        body: { key: apiKey },
      })

      if (!result.valid || !result.key) {
        span.setAttributes({ "auth.apikey_valid": false })
        getAuthCounter().add(1, { operation: "verify_apikey", result: "invalid" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "verify_apikey", result: "invalid" })
        return null
      }

      // Get user from referenceId (which is the userId)
      const [foundUser] = await db
        .select()
        .from(user)
        .where(eq(user.id, result.key.referenceId))
        .limit(1)

      if (!foundUser) {
        span.setAttributes({ "auth.apikey_valid": true, "auth.user_found": false })
        getAuthCounter().add(1, { operation: "verify_apikey", result: "user_not_found" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "verify_apikey", result: "user_not_found" })
        return null
      }

      span.setAttributes({
        "auth.apikey_valid": true,
        "auth.user_id": foundUser.id,
        "auth.user_email": foundUser.email,
      })

      getAuthCounter().add(1, { operation: "verify_apikey", result: "success" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "verify_apikey", result: "success" })

      return {
        userId: foundUser.id,
        email: foundUser.email,
        name: foundUser.name,
        image: foundUser.image ?? null,
        orgId: "",
        role: "",
      }
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      logger.error("API key verification error", { error: String(err) })
      getAuthCounter().add(1, { operation: "verify_apikey", result: "error" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "verify_apikey", result: "error" })
      return null
    }
  })
}

interface RequireAuthOptions {
  /** Token passed via query param (for SSE endpoints that can't use headers) */
  token?: string
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(headers: Headers): string | null {
  const authHeader = headers.get("authorization")
  if (!authHeader) return null
  
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

/**
 * Require authentication for protected routes.
 * Supports:
 * - Session cookies (web app)
 * - Bearer token with API key (CLI/API)
 * - Query param token (SSE endpoints)
 * - Dev mode headers (testing)
 */
export async function requireAuth(
  headers: Headers,
  options: RequireAuthOptions = {},
): Promise<AuthContext> {
  const start = Date.now()

  return withSpan("auth.requireAuth", async (span) => {
    const env = getEnv()

    // 1. Try Bearer token (API key) from Authorization header
    const bearerToken = extractBearerToken(headers)
    if (bearerToken) {
      span.setAttributes({ "auth.method": "bearer" })
      
      // Check if it looks like an API key (has prefix)
      if (bearerToken.startsWith("yfl_")) {
        const authContext = await verifyApiKey(bearerToken)
        if (authContext) {
          getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "apikey" })
          getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "apikey" })
          return authContext
        }
      }
      
      // Try as session token
      const cookieHeaders = new Headers(headers)
      cookieHeaders.set("cookie", `better-auth.session_token=${bearerToken}`)
      
      const session = await getSession(cookieHeaders)
      if (session) {
        getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "bearer_session" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "bearer_session" })
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

    // 2. For SSE endpoints, token might be passed as query param
    if (options.token) {
      span.setAttributes({ "auth.method": "query_param" })
      
      // Check if it's an API key
      if (options.token.startsWith("yfl_")) {
        const authContext = await verifyApiKey(options.token)
        if (authContext) {
          getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "query_apikey" })
          getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "query_apikey" })
          return authContext
        }
      }
      
      // Try as session token
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

    // 3. Try session from cookies
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

    // 4. Dev mode: accept special headers for testing
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
        throw new AuthError("missing dev auth headers (x-yaffle-user-id, x-yaffle-user-email)", "AUTH_REQUIRED")
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
