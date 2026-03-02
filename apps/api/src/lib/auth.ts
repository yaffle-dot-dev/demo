import { getEnv } from "./env.ts"
import { findOrgByLogin } from "../db/queries/organizations.ts"
import { ensureMembership, ensureUser } from "../db/queries/users.ts"
import { createAuthClient, subjects } from "./openauth.ts"
import { logger } from "./telemetry.ts"

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
  const env = getEnv()
  const client = createAuthClient()
  logger.debug("verifying token", { issuer: env.authIssuer, clientId: env.authClientId })

  const verified = await client.verify(subjects, token)
  if (verified.err) {
    logger.warn("token verification failed", {
      error: verified.err,
      issuer: env.authIssuer,
    })
    throw new AuthError(`token verification failed: ${verified.err}`, "INVALID_TOKEN")
  }

  const subject = verified.subject
  if (subject.type !== "user") {
    throw new AuthError(`invalid subject type: ${subject.type}`, "INVALID_SUBJECT")
  }

  const props = subject.properties as {
    userId: string
    login: string
    provider: string
    externalId: string
  }

  logger.debug("token verified", { userId: props.userId, login: props.login })

  return {
    userId: props.userId,
    externalId: props.externalId,
    login: props.login,
    orgId: "",
    role: "",
    provider: props.provider,
  }
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
  const env = getEnv()

  // Try Bearer token from Authorization header first
  const authHeader = headers.get("authorization") ?? ""
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "").trim()
    if (!token) {
      throw new AuthError("empty bearer token", "INVALID_TOKEN")
    }

    try {
      return await verifyToken(token)
    } catch (err) {
      if (err instanceof AuthError) throw err
      logger.error("token verification error", { error: String(err) })
      throw new AuthError(`token verification error: ${err}`, "VERIFICATION_ERROR")
    }
  }

  // Try token from query param (for SSE endpoints)
  if (options.token) {
    try {
      return await verifyToken(options.token)
    } catch (err) {
      if (err instanceof AuthError) throw err
      logger.error("token verification error", { error: String(err) })
      throw new AuthError(`token verification error: ${err}`, "VERIFICATION_ERROR")
    }
  }

  // Dev mode: accept special headers for testing
  if (env.authMode === "dev") {
    const login = headers.get("x-yaffle-user-login") ?? ""
    const userId = headers.get("x-yaffle-user-id") ?? ""
    const orgLogin = headers.get("x-yaffle-org") ?? ""
    const role = headers.get("x-yaffle-role") ?? "viewer"

    if (!login || !userId || !orgLogin) {
      throw new AuthError("missing dev auth headers", "MISSING_HEADERS")
    }

    const org = await findOrgByLogin(orgLogin)
    if (!org) {
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

    return {
      userId: user.id,
      externalId: user.externalId,
      login: user.login,
      orgId: org.id,
      role,
      provider: user.provider,
    }
  }

  throw new AuthError("no valid authentication provided", "AUTH_REQUIRED")
}
