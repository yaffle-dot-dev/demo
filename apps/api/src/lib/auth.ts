import { getEnv } from "./env.ts"
import { findOrgByLogin } from "../db/queries/organizations.ts"
import { ensureMembership, ensureUser } from "../db/queries/users.ts"
import { createAuthClient, subjects } from "./openauth.ts"
import {
  logger,
  withSpan,
  getAuthDurationHistogram,
  getAuthCounter,
  SpanStatusCode,
} from "./telemetry.ts"

export interface AuthContext {
  userId: string
  externalId: string
  login: string
  orgId: string
  role: string
  provider: string
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
 * Verify a token and return auth context.
 */
async function verifyToken(token: string): Promise<AuthContext> {
  const start = Date.now()

  return withSpan("auth.verifyToken", async (span) => {
    const env = getEnv()
    const client = createAuthClient()

    span.setAttributes({
      "auth.issuer": env.authIssuer,
      "auth.client_id": env.authClientId,
    })
    logger.debug("verifying token", { issuer: env.authIssuer, clientId: env.authClientId })

    const verified = await client.verify(subjects, token)
    if (verified.err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(verified.err) })
      span.setAttributes({ "auth.error": String(verified.err) })

      getAuthCounter().add(1, { operation: "verify_token", result: "error" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "verify_token", result: "error" })

      logger.warn("token verification failed", {
        error: String(verified.err),
        issuer: env.authIssuer,
      })
      throw new AuthError(`token verification failed: ${verified.err}`, "INVALID_TOKEN")
    }

    const subject = verified.subject
    if (subject.type !== "user") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `invalid subject type: ${subject.type}` })

      getAuthCounter().add(1, { operation: "verify_token", result: "invalid_subject" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "verify_token", result: "invalid_subject" })

      throw new AuthError(`invalid subject type: ${subject.type}`, "INVALID_SUBJECT")
    }

    const props = subject.properties as {
      userId: string
      login: string
      provider: string
      externalId: string
    }

    span.setAttributes({
      "auth.user_id": props.userId,
      "auth.login": props.login,
      "auth.provider": props.provider,
    })
    logger.debug("token verified", { userId: props.userId, login: props.login })

    getAuthCounter().add(1, { operation: "verify_token", result: "success" })
    getAuthDurationHistogram().record(Date.now() - start, { operation: "verify_token", result: "success" })

    return {
      userId: props.userId,
      externalId: props.externalId,
      login: props.login,
      orgId: "",
      role: "",
      provider: props.provider,
    }
  })
}

interface RequireAuthOptions {
  /** Token passed via query param (for SSE endpoints that can't use headers) */
  token?: string
}

/**
 * Require authentication for protected routes.
 * Supports Bearer token in header, token in query param (for SSE), or dev mode headers.
 */
export async function requireAuth(
  headers: Headers,
  options: RequireAuthOptions = {},
): Promise<AuthContext> {
  const start = Date.now()

  return withSpan("auth.requireAuth", async (span) => {
    const env = getEnv()

    // Try Bearer token from Authorization header first
    const authHeader = headers.get("authorization") ?? ""
    if (authHeader.startsWith("Bearer ")) {
      span.setAttributes({ "auth.method": "bearer" })
      const token = authHeader.replace("Bearer ", "").trim()
      if (!token) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "empty bearer token" })
        getAuthCounter().add(1, { operation: "require_auth", result: "empty_token" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "empty_token" })
        throw new AuthError("empty bearer token", "INVALID_TOKEN")
      }

      try {
        const ctx = await verifyToken(token)
        getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "bearer" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "bearer" })
        return ctx
      } catch (err) {
        if (err instanceof AuthError) throw err
        logger.error("token verification error", { error: String(err) })
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
        getAuthCounter().add(1, { operation: "require_auth", result: "verification_error" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "verification_error" })
        throw new AuthError(`token verification error: ${err}`, "VERIFICATION_ERROR")
      }
    }

    // Try token from query param (for SSE endpoints)
    if (options.token) {
      span.setAttributes({ "auth.method": "query_param" })
      try {
        const ctx = await verifyToken(options.token)
        getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "query_param" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "query_param" })
        return ctx
      } catch (err) {
        if (err instanceof AuthError) throw err
        logger.error("token verification error", { error: String(err) })
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
        getAuthCounter().add(1, { operation: "require_auth", result: "verification_error" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "verification_error" })
        throw new AuthError(`token verification error: ${err}`, "VERIFICATION_ERROR")
      }
    }

    // Dev mode: accept special headers for testing
    if (env.authMode === "dev") {
      span.setAttributes({ "auth.method": "dev_headers" })
      const login = headers.get("x-yaffle-user-login") ?? ""
      const userId = headers.get("x-yaffle-user-id") ?? ""
      const orgLogin = headers.get("x-yaffle-org") ?? ""
      const role = headers.get("x-yaffle-role") ?? "viewer"

      if (!login || !userId || !orgLogin) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "missing dev auth headers" })
        getAuthCounter().add(1, { operation: "require_auth", result: "missing_headers" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "missing_headers" })
        throw new AuthError("missing dev auth headers", "MISSING_HEADERS")
      }

      const org = await findOrgByLogin(orgLogin)
      if (!org) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `organization not found: ${orgLogin}` })
        getAuthCounter().add(1, { operation: "require_auth", result: "org_not_found" })
        getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "org_not_found" })
        throw new AuthError(`organization not found: ${orgLogin}`, "ORG_NOT_FOUND")
      }

      const user = await ensureUser({
        login,
        externalId: userId,
        provider: "dev",
      })

      await ensureMembership({
        orgId: org.id,
        userId: user.id,
        role,
      })

      span.setAttributes({
        "auth.user_id": user.id,
        "auth.login": user.login,
        "auth.org_id": org.id,
        "auth.role": role,
      })

      getAuthCounter().add(1, { operation: "require_auth", result: "success", method: "dev" })
      getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "success", method: "dev" })

      return {
        userId: user.id,
        externalId: user.externalId,
        login: user.login,
        orgId: org.id,
        role,
        provider: user.provider,
      }
    }

    span.setStatus({ code: SpanStatusCode.ERROR, message: "no valid authentication provided" })
    getAuthCounter().add(1, { operation: "require_auth", result: "no_auth" })
    getAuthDurationHistogram().record(Date.now() - start, { operation: "require_auth", result: "no_auth" })
    throw new AuthError("no valid authentication provided", "AUTH_REQUIRED")
  })
}
