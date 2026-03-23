import { getEnv } from "./env.ts"
import { auth, type Session } from "./better-auth.ts"
import { db } from "./db.ts"
import { apikey, user } from "../db/auth-schema.ts"
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
  apiKeyId?: string
  apiKeyMetadata?: ApiKeyMetadata | null
  apiKeyPermissions?: ApiKeyPermissions | null
}

export interface ApiKeyMetadata {
  orgId?: string
  orgSlug?: string
  orgName?: string
  access?: "read" | "write"
  createdByFlow?: string
}

export type ApiKeyPermissions = Record<string, string[]>

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
function parseJsonObject<T>(value: unknown): T | null {
  if (!value) return null
  if (typeof value === "object") return value as T
  if (typeof value !== "string") return null

  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

async function verifyApiKey(
  apiKey: string,
  permissions?: ApiKeyPermissions,
): Promise<AuthContext | null> {
  const start = Date.now()

  return withSpan("auth.verifyApiKey", async (span) => {
    try {
      const result = await auth.api.verifyApiKey({
        body: { key: apiKey, permissions },
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

      const [storedApiKey] = await db
        .select({
          id: apikey.id,
          metadata: apikey.metadata,
          permissions: apikey.permissions,
        })
        .from(apikey)
        .where(eq(apikey.id, result.key.id))
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
        apiKeyId: storedApiKey?.id,
        apiKeyMetadata: parseJsonObject<ApiKeyMetadata>(storedApiKey?.metadata),
        apiKeyPermissions: parseJsonObject<ApiKeyPermissions>(storedApiKey?.permissions),
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
  /** API key passed via query param for SSE-style endpoints */
  token?: string
  /** Required Better Auth API key permissions */
  apiKeyPermissions?: ApiKeyPermissions
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
 * - Query param API key (legacy SSE endpoints only)
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
        const authContext = await verifyApiKey(bearerToken, options.apiKeyPermissions)
        if (authContext) {
          getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "apikey" })
          getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "apikey" })
          return authContext
        }
      }
    }

    // 2. For SSE endpoints, a legacy API key might be passed as query param.
    // Session tokens are intentionally NOT accepted via query string.
    if (options.token) {
      span.setAttributes({ "auth.method": "query_param" })

      if (options.token.startsWith("yfl_")) {
        const authContext = await verifyApiKey(options.token, options.apiKeyPermissions)
        if (authContext) {
          getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "query_apikey" })
          getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "query_apikey" })
          return authContext
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
