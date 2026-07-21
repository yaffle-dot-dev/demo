import { createHmac } from "node:crypto"

import { SignJWT, jwtVerify, type JWTPayload } from "jose"

import { TFC_SCOPES } from "../db/queries/api-tokens.ts"
import { getEnv } from "./env.ts"
import { logger as log } from "./telemetry.ts"

const DEFAULT_RUN_TOKEN_SCOPES = [
  TFC_SCOPES.workspaceRead,
  TFC_SCOPES.stateRead,
  TFC_SCOPES.stateWrite,
  TFC_SCOPES.stateDownload,
  TFC_SCOPES.workspaceLock,
]

export function getRunTokenScopes(runType: "plan" | "apply" | "destroy"): string[] {
  return runType === "destroy"
    ? [...DEFAULT_RUN_TOKEN_SCOPES, TFC_SCOPES.workspaceDestroy]
    : [...DEFAULT_RUN_TOKEN_SCOPES]
}

export function getMergeImpactRunTokenScopes(): string[] {
  return [TFC_SCOPES.workspaceRead, TFC_SCOPES.stateRead, TFC_SCOPES.stateDownload]
}

/**
 * Run token payload structure.
 */
export interface RunTokenPayload extends JWTPayload {
  sub: string // "run:{run_id}"
  run_id: string
  job_id: string
  deployment_id: string
  run_group_id: string
  workspace_id: string
  org_id: string
  scopes: string[]
}

export interface RunTokenCapability {
  runId: string
  jobId: string
  deploymentId: string
  runGroupId: string
  workspaceId: string
  orgId: string
  scopes?: string[]
  ttlHours?: number
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
  return createHmac("sha256", secret).update("yaffle-run-capability-v1").digest()
}

const TOKEN_ISSUER = "yaffle-control-plane"
const TOKEN_AUDIENCE = "yaffle-tfc-runner"

/**
 * Generate a run token (JWT) for automated Terraform runs.
 *
 * @param runId - The run ID
 * @param workspaceId - The workspace ID this token is scoped to
 * @param orgId - The organization ID
 * @param scopes - Permission scopes (default: workspace:read, state:read, state:write, state:download, workspace:lock)
 * @param ttlHours - Token TTL in hours (default: 4)
 */
export async function generateRunToken(capability: RunTokenCapability): Promise<string> {
  const secret = getJwtSecret()
  const scopes = capability.scopes ?? DEFAULT_RUN_TOKEN_SCOPES

  const token = await new SignJWT({
    run_id: capability.runId,
    job_id: capability.jobId,
    deployment_id: capability.deploymentId,
    run_group_id: capability.runGroupId,
    workspace_id: capability.workspaceId,
    org_id: capability.orgId,
    scopes,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`run:${capability.runId}`)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${capability.ttlHours ?? 4}h`)
    .sign(secret)

  log.debug("Run token generated", {
    runId: capability.runId,
    jobId: capability.jobId,
    deploymentId: capability.deploymentId,
    workspaceId: capability.workspaceId,
    orgId: capability.orgId,
  })
  return token
}

/**
 * Verify a run token (JWT).
 */
export async function verifyRunToken(token: string): Promise<RunTokenPayload | null> {
  try {
    const secret = getJwtSecret()
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    })
    const subjectMatchesRun =
      typeof payload.run_id === "string" && payload.sub === `run:${payload.run_id}`

    // Validate required fields
    if (
      typeof payload.run_id !== "string" ||
      !subjectMatchesRun ||
      typeof payload.job_id !== "string" ||
      typeof payload.deployment_id !== "string" ||
      typeof payload.run_group_id !== "string" ||
      typeof payload.workspace_id !== "string" ||
      typeof payload.org_id !== "string" ||
      !Array.isArray(payload.scopes) ||
      !payload.scopes.every((scope) => typeof scope === "string")
    ) {
      log.debug("Run token validation failed: missing required fields", {
        hasSub: !!payload.sub,
        subjectMatchesRun,
        hasRunId: typeof payload.run_id === "string",
        hasJobId: typeof payload.job_id === "string",
        hasDeploymentId: typeof payload.deployment_id === "string",
        hasRunGroupId: typeof payload.run_group_id === "string",
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
