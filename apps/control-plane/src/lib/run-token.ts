import { SignJWT, jwtVerify, type JWTPayload } from "jose"

import { getEnv } from "./env.ts"
import { logger as log } from "./telemetry.ts"

/**
 * Run token payload structure.
 */
export interface RunTokenPayload extends JWTPayload {
  sub: string // "run:{run_id}"
  workspace_id: string
  org_id: string
  scopes: string[]
}

/**
 * Get the JWT signing secret.
 * Uses YAFFLE_RUN_TOKEN_SECRET if set, falls back to BETTER_AUTH_SECRET.
 */
function getJwtSecret(): Uint8Array {
  const env = getEnv()
  const secret = process.env.YAFFLE_RUN_TOKEN_SECRET ?? env.betterAuthSecret
  if (!secret) {
    throw new Error("No JWT secret configured (YAFFLE_RUN_TOKEN_SECRET or BETTER_AUTH_SECRET)")
  }
  return new TextEncoder().encode(secret)
}

/**
 * Generate a run token (JWT) for automated Terraform runs.
 *
 * @param runId - The run ID
 * @param workspaceId - The workspace ID this token is scoped to
 * @param orgId - The organization ID
 * @param scopes - Permission scopes (default: workspace:read, state:read, state:write, state:download, workspace:lock)
 * @param ttlHours - Token TTL in hours (default: 4)
 */
export async function generateRunToken(
  runId: string,
  workspaceId: string,
  orgId: string,
  scopes: string[] = [
    "workspace:read",
    "state:read",
    "state:write",
    "state:download",
    "workspace:lock",
  ],
  ttlHours: number = 4,
): Promise<string> {
  const secret = getJwtSecret()

  const token = await new SignJWT({
    workspace_id: workspaceId,
    org_id: orgId,
    scopes,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`run:${runId}`)
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(secret)

  log.debug("Run token generated", { runId, workspaceId, orgId })
  return token
}

/**
 * Verify a run token (JWT).
 */
export async function verifyRunToken(token: string): Promise<RunTokenPayload | null> {
  try {
    const secret = getJwtSecret()
    const { payload } = await jwtVerify(token, secret)

    // Validate required fields
    if (
      !payload.sub?.startsWith("run:") ||
      typeof payload.workspace_id !== "string" ||
      typeof payload.org_id !== "string" ||
      !Array.isArray(payload.scopes)
    ) {
      log.debug("Run token validation failed: missing required fields", {
        hasSub: !!payload.sub,
        subStartsWithRun: payload.sub?.startsWith("run:"),
        hasWorkspaceId: typeof payload.workspace_id === "string",
        hasOrgId: typeof payload.org_id === "string",
        hasScopes: Array.isArray(payload.scopes),
      })
      return null
    }

    return payload as RunTokenPayload
  } catch (err) {
    log.debug("Run token JWT verification failed", { error: String(err) })
    return null
  }
}

/**
 * Build the Terraform token environment variable name for a hostname.
 * Terraform uses TF_TOKEN_<hostname> where dots and colons become underscores.
 *
 * Examples:
 * - yaffle.dev -> TF_TOKEN_yaffle_dev
 * - localhost:3000 -> TF_TOKEN_localhost_3000
 */
export function buildTfTokenEnvName(hostname: string): string {
  const sanitized = hostname.replace(/[.:]/g, "_")
  return `TF_TOKEN_${sanitized}`
}

/**
 * Get the TFC API host from environment.
 */
export function getTfcApiHost(): string {
  const host = process.env.YAFFLE_TFC_API_HOST
  if (!host) {
    throw new Error("YAFFLE_TFC_API_HOST must be configured")
  }
  return host
}
