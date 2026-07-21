import { createHmac } from "node:crypto"

import { SignJWT, jwtVerify, type JWTPayload } from "jose"

import { getEnv } from "./env.ts"
import { logger as log } from "./telemetry.ts"

/**
 * Job token payload structure.
 * Used for runner authentication - scoped to a single job.
 */
export interface JobTokenPayload extends JWTPayload {
  sub: string // "job:{job_id}"
  job_id: string
  deployment_id: string
  org_id: string
  spawn_lease_token?: string
}

export interface WarmRunnerTokenPayload extends JWTPayload {
  sub: string // "warm-runner:{org_id}"
  org_id: string
  runner_mode: "warm"
}

/**
 * Get the JWT signing secret for job tokens.
 * Uses YAFFLE_JOB_TOKEN_SECRET if set, falls back to YAFFLE_RUN_TOKEN_SECRET,
 * then BETTER_AUTH_SECRET.
 */
function getJwtSecret(): Uint8Array {
  const env = getEnv()
  const secret =
    process.env.YAFFLE_JOB_TOKEN_SECRET ??
    process.env.YAFFLE_RUN_TOKEN_SECRET ??
    env.betterAuthSecret
  if (!secret) {
    throw new Error("No JWT secret configured for job tokens")
  }
  return createHmac("sha256", secret).update("yaffle-job-capability-v1").digest()
}

const TOKEN_ISSUER = "yaffle-control-plane"

/**
 * Generate a job token (JWT) for runner authentication.
 *
 * @param jobId - The job ID this token is scoped to
 * @param deploymentId - The deployment ID for this job
 * @param orgId - The organization ID
 * @param ttlHours - Token TTL in hours (default: 4)
 */
export async function generateJobToken(
  jobId: string,
  deploymentId: string,
  orgId: string,
  spawnLeaseToken?: string,
  ttlHours: number = 4,
): Promise<string> {
  const secret = getJwtSecret()

  const token = await new SignJWT({
    job_id: jobId,
    deployment_id: deploymentId,
    org_id: orgId,
    spawn_lease_token: spawnLeaseToken,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`job:${jobId}`)
    .setIssuer(TOKEN_ISSUER)
    .setAudience("yaffle-job-runner")
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(secret)

  log.debug("Job token generated", { jobId, deploymentId, orgId })
  return token
}

/**
 * Generate a warm-runner token (JWT) scoped to a single org.
 */
export async function generateWarmRunnerToken(
  orgId: string,
  ttlHours: number = 12,
): Promise<string> {
  const secret = getJwtSecret()

  const token = await new SignJWT({
    org_id: orgId,
    runner_mode: "warm",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`warm-runner:${orgId}`)
    .setIssuer(TOKEN_ISSUER)
    .setAudience("yaffle-warm-runner")
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(secret)

  log.debug("Warm runner token generated", { orgId })
  return token
}

// =============================================================================
// Scan Job Tokens
// =============================================================================

/**
 * Scan job token payload. Scoped to a single scan job (no deployment).
 */
export interface ScanJobTokenPayload extends JWTPayload {
  sub: string // "scan:{scan_job_id}"
  scan_job_id: string
  org_id: string
}

/**
 * Generate a scan job token (JWT) for scanner worker authentication.
 */
export async function generateScanJobToken(
  scanJobId: string,
  orgId: string,
  ttlHours: number = 1,
): Promise<string> {
  const secret = getJwtSecret()

  const token = await new SignJWT({
    scan_job_id: scanJobId,
    org_id: orgId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`scan:${scanJobId}`)
    .setIssuer(TOKEN_ISSUER)
    .setAudience("yaffle-scan-runner")
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(secret)

  log.debug("Scan job token generated", { scanJobId, orgId })
  return token
}

/**
 * Verify a scan job token (JWT).
 */
export async function verifyScanJobToken(token: string): Promise<ScanJobTokenPayload | null> {
  try {
    const secret = getJwtSecret()
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: "yaffle-scan-runner",
    })

    if (
      typeof payload.scan_job_id !== "string" ||
      payload.sub !== `scan:${payload.scan_job_id}` ||
      typeof payload.org_id !== "string"
    ) {
      log.debug("Scan job token validation failed: missing required fields")
      return null
    }

    return payload as ScanJobTokenPayload
  } catch (err) {
    log.debug("Scan job token JWT verification failed", { error: String(err) })
    return null
  }
}

// =============================================================================
// IaC Job Token Verification
// =============================================================================

/**
 * Verify a job token (JWT).
 */
export async function verifyJobToken(token: string): Promise<JobTokenPayload | null> {
  try {
    const secret = getJwtSecret()
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: "yaffle-job-runner",
    })
    const subjectMatchesJob =
      typeof payload.job_id === "string" && payload.sub === `job:${payload.job_id}`

    // Validate required fields
    if (
      typeof payload.job_id !== "string" ||
      !subjectMatchesJob ||
      typeof payload.deployment_id !== "string" ||
      typeof payload.org_id !== "string" ||
      (payload.spawn_lease_token !== undefined && typeof payload.spawn_lease_token !== "string")
    ) {
      log.debug("Job token validation failed: missing required fields", {
        hasSub: !!payload.sub,
        subjectMatchesJob,
        hasJobId: typeof payload.job_id === "string",
        hasDeploymentId: typeof payload.deployment_id === "string",
        hasOrgId: typeof payload.org_id === "string",
        hasValidSpawnLeaseToken:
          payload.spawn_lease_token === undefined || typeof payload.spawn_lease_token === "string",
      })
      return null
    }

    return payload as JobTokenPayload
  } catch (err) {
    log.debug("Job token JWT verification failed", { error: String(err) })
    return null
  }
}

/**
 * Verify a warm-runner token (JWT).
 */
export async function verifyWarmRunnerToken(token: string): Promise<WarmRunnerTokenPayload | null> {
  try {
    const secret = getJwtSecret()
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: "yaffle-warm-runner",
    })
    const subjectMatchesWarmRunner =
      typeof payload.org_id === "string" && payload.sub === `warm-runner:${payload.org_id}`

    if (
      typeof payload.org_id !== "string" ||
      !subjectMatchesWarmRunner ||
      payload.runner_mode !== "warm"
    ) {
      log.debug("Warm runner token validation failed: missing required fields", {
        hasSub: !!payload.sub,
        subjectMatchesWarmRunner,
        hasOrgId: typeof payload.org_id === "string",
        hasWarmMode: payload.runner_mode === "warm",
      })
      return null
    }

    return payload as WarmRunnerTokenPayload
  } catch (err) {
    log.debug("Warm runner token JWT verification failed", { error: String(err) })
    return null
  }
}
