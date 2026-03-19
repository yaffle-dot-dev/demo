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
}

/**
 * Get the JWT signing secret for job tokens.
 * Uses YAFFLE_JOB_TOKEN_SECRET if set, falls back to YAFFLE_RUN_TOKEN_SECRET,
 * then BETTER_AUTH_SECRET.
 */
function getJwtSecret(): Uint8Array {
  const env = getEnv()
  const secret = process.env.YAFFLE_JOB_TOKEN_SECRET
    ?? process.env.YAFFLE_RUN_TOKEN_SECRET
    ?? env.betterAuthSecret
  if (!secret) {
    throw new Error("No JWT secret configured for job tokens")
  }
  return new TextEncoder().encode(secret)
}

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
  ttlHours: number = 4,
): Promise<string> {
  const secret = getJwtSecret()

  const token = await new SignJWT({
    job_id: jobId,
    deployment_id: deploymentId,
    org_id: orgId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`job:${jobId}`)
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(secret)

  log.debug("Job token generated", { jobId, deploymentId, orgId })
  return token
}

/**
 * Verify a job token (JWT).
 */
export async function verifyJobToken(token: string): Promise<JobTokenPayload | null> {
  try {
    const secret = getJwtSecret()
    const { payload } = await jwtVerify(token, secret)

    // Validate required fields
    if (
      !payload.sub?.startsWith("job:") ||
      typeof payload.job_id !== "string" ||
      typeof payload.deployment_id !== "string" ||
      typeof payload.org_id !== "string"
    ) {
      log.debug("Job token validation failed: missing required fields", {
        hasSub: !!payload.sub,
        subStartsWithJob: payload.sub?.startsWith("job:"),
        hasJobId: typeof payload.job_id === "string",
        hasDeploymentId: typeof payload.deployment_id === "string",
        hasOrgId: typeof payload.org_id === "string",
      })
      return null
    }

    return payload as JobTokenPayload
  } catch (err) {
    log.debug("Job token JWT verification failed", { error: String(err) })
    return null
  }
}
