import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { z } from "zod"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { db } from "../lib/db.ts"
import { getEnv } from "../lib/env.ts"
import { listUserOrgs, ensureMembership } from "../db/queries/users.ts"
import { findOrgBySlug, findOrgMembership, createOrg, updateOrg } from "../db/queries/organizations.ts"
import { createJob } from "../db/queries/jobs.ts"
import { getStripe } from "../lib/stripe.ts"
import { listConnectionsForOrg } from "../db/queries/connections.ts"
import { createConnection } from "../db/queries/connections.ts"
import { deleteConnection, findConnectionById, updateConnection } from "../db/queries/connections.ts"
import { storeConnectionSecret } from "../lib/connection-secrets.ts"
import { getConnectionSecret } from "../lib/connection-secrets.ts"
import { deleteConnectionSecret } from "../lib/connection-secrets.ts"
import type { AwsSessionCredentials } from "../lib/connection-secrets.ts"
import { syncOrgBrokerRoleAssumeTargets } from "../lib/org-provisioning.ts"
import { assumeOrgBrokerRole } from "../lib/org-broker-auth.ts"
import { uuidv7 } from "uuidv7"
import { listLatestDeploymentsForOrg } from "../db/queries/workspace-deployments.ts"
import { findMissingConnectionRequirements } from "../lib/provider-requirements.ts"
import { connectionScopesOverlap, type ConnectionScopeConfig } from "../lib/connection-scope.ts"
import { withSpan } from "../lib/telemetry.ts"
import { inferProviderTypeFromEnvVarKeys } from "../lib/provider-credential-inference.ts"
import { listActiveProviderCredentialSignatures } from "../db/queries/provider-credential-signatures.ts"
import {
  approvals,
  connections,
  githubInstallations,
  jobs,
  organizations,
  repositories,
  tfRuns,
  workspaceDeployments,
  workspaces,
} from "../db/schema.ts"
import { deprovisionOrgResources } from "../lib/org-provisioning.ts"

export const orgsRoute = new Hono()

const createConnectionSchema = z.discriminatedUnion("credentialProviderType", [
  z.object({
    name: z.string().min(1),
    providerType: z.string().min(1),
    credentialProviderType: z.literal("envvar"),
    environmentScope: z.array(z.string()).default([]),
    workspaceScope: z.array(z.string()).default([]),
    envVars: z.array(z.object({
      key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
      value: z.string().min(1),
    })).min(1),
  }),
  z.object({
    name: z.string().min(1),
    providerType: z.literal("aws"),
    credentialProviderType: z.literal("iam_role"),
    environmentScope: z.array(z.string()).default([]),
    workspaceScope: z.array(z.string()).default([]),
    roleArn: z.string().regex(/^arn:aws(-[a-z]+)?:iam::\d{12}:role\/.+$/, "Invalid IAM role ARN"),
    externalId: z.string().optional(),
  }),
])

function buildScopeSummary(environmentScope: string[], workspaceScope: string[]): string {
  return [
    environmentScope.length > 0 ? environmentScope.join(", ") : "all environments",
    workspaceScope.length > 0 ? workspaceScope.join(", ") : "all workspaces",
  ].join(" / ")
}

function appendServerTiming(existing: string | null, name: string, durationMs: number): string {
  const metric = `${name};dur=${Math.max(0, durationMs).toFixed(1)}`
  return existing ? `${existing}, ${metric}` : metric
}

async function resolveConnectionProviderType(payload: z.infer<typeof createConnectionSchema>): Promise<string> {
  if (payload.credentialProviderType === "envvar") {
    const requested = payload.providerType.toLowerCase()
    if (requested !== "generic") {
      return requested
    }

    return inferProviderTypeFromEnvVarKeys(payload.envVars.map((entry) => entry.key))
  }

  return payload.providerType.toLowerCase()
}

type CloudflareTokenValidationError = {
  code: string
  message: string
  status: 400 | 502 | 503
}

async function validateCloudflareApiToken(
  resolvedProviderType: string,
  envVars: Array<{ key: string; value: string }>,
): Promise<CloudflareTokenValidationError | null> {
  if (resolvedProviderType !== "cloudflare") {
    return null
  }

  const token = envVars.find((entry) => entry.key === "CLOUDFLARE_API_TOKEN")?.value
  if (!token) {
    return null
  }

  let response: Response
  try {
    response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
  } catch {
    return {
      code: "CLOUDFLARE_TOKEN_VERIFY_UNAVAILABLE",
      message: "Could not reach Cloudflare to validate API token",
      status: 502,
    }
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (response.ok && typeof body === "object" && body !== null && "success" in body && (body as { success: unknown }).success === true) {
    return null
  }

  if (response.status === 401 || response.status === 403) {
    return {
      code: "CLOUDFLARE_TOKEN_INVALID",
      message: "Cloudflare API token is invalid or unauthorized",
      status: 400,
    }
  }

  if (response.status === 429) {
    return {
      code: "CLOUDFLARE_TOKEN_VERIFY_RATE_LIMITED",
      message: "Cloudflare token verification was rate limited. Please retry.",
      status: 503,
    }
  }

  return {
    code: "CLOUDFLARE_TOKEN_VERIFY_FAILED",
    message: "Cloudflare token verification failed",
    status: 502,
  }
}

async function getOrgBrokerCredentials(org: {
  id: string
  iamRoleArn: string | null
}): Promise<AwsSessionCredentials> {
  if (!org.iamRoleArn) {
    throw new Error("Organization broker role is not configured")
  }

  return assumeOrgBrokerRole(org.id, org.iamRoleArn)
}

function listIamRoleTargets(connections: Array<{ credentialProviderType: string | null; config: unknown }>): string[] {
  const targets = new Set<string>()

  for (const connection of connections) {
    if (connection.credentialProviderType !== "iam_role") {
      continue
    }

    const config = typeof connection.config === "object" && connection.config !== null
      ? connection.config as Record<string, unknown>
      : {}

    const roleArn = typeof config.roleArn === "string" ? config.roleArn : null
    if (roleArn) {
      targets.add(roleArn)
    }
  }

  return [...targets].sort()
}

function buildProviderInferenceMetadata(payload: z.infer<typeof createConnectionSchema>, resolvedProviderType: string): {
  inferred: boolean
  source: "envvar_keys"
  requestedProviderType: string
} | null {
  if (payload.credentialProviderType !== "envvar") {
    return null
  }

  const requestedProviderType = payload.providerType.toLowerCase()
  if (requestedProviderType !== "generic") {
    return null
  }

  if (resolvedProviderType === "generic") {
    return null
  }

  return {
    inferred: true,
    source: "envvar_keys",
    requestedProviderType,
  }
}

const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens").optional(),
})

const deleteOrgSchema = z.object({
  confirmSlug: z.string().min(1),
})

/**
 * POST /api/orgs
 *
 * Create a new organization. The requesting user becomes the admin.
 * Queues async provisioning of AWS resources (KMS key, IAM role).
 */
orgsRoute.post("/", async (c) => {
  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  let body: z.infer<typeof createOrgSchema>
  try {
    body = createOrgSchema.parse(await c.req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: err.errors[0].message } }, 400)
    }
    return c.json({ error: { code: "INVALID_JSON", message: "Invalid request body" } }, 400)
  }

  const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
  if (!slug) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Could not derive a valid slug from the org name" } }, 400)
  }

  // Check for slug collision
  const existing = await findOrgBySlug(slug)
  if (existing) {
    return c.json({ error: { code: "SLUG_TAKEN", message: `Organization slug "${slug}" is already in use` } }, 409)
  }

  const org = await createOrg({
    name: body.name,
    slug,
    membershipMode: "invite_only",
  })

  // Make the requesting user an admin
  await ensureMembership({
    orgId: org.id,
    userId: auth.userId,
    role: "admin",
    source: "admin_bootstrap",
  })

  // Queue async provisioning of AWS resources (KMS key, IAM role)
  await createJob({
    orgId: org.id,
    jobType: "org_provision",
    payload: {
      orgId: org.id,
      orgSlug: slug,
    },
  })

  // Create Stripe customer for billing (non-blocking — org works without it)
  const stripe = getStripe()
  if (stripe) {
    try {
      const customer = await stripe.customers.create({
        name: body.name,
        metadata: {
          orgId: org.id,
          orgSlug: slug,
        },
      })
      await updateOrg(org.id, { stripeCustomerId: customer.id })
    } catch (err) {
      // Log but don't fail org creation — billing can be linked later
      console.error(`failed to create Stripe customer for org ${slug}:`, err instanceof Error ? err.message : err)
    }
  }

  return c.json({ data: { id: org.id, slug: org.slug, name: org.name } }, 201)
})

/**
 * DELETE /api/orgs/:slug
 *
 * Delete an organization after explicit slug confirmation.
 * This removes org-scoped app data and best-effort deprovisions org AWS resources.
 */
orgsRoute.delete("/:slug", async (c) => {
  const slug = c.req.param("slug")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership || membership.role !== "admin") {
    return c.json({ error: { code: "FORBIDDEN", message: "Only org admins can delete organizations" } }, 403)
  }

  let body: z.infer<typeof deleteOrgSchema>
  try {
    body = deleteOrgSchema.parse(await c.req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: err.errors[0].message } }, 400)
    }
    return c.json({ error: { code: "INVALID_JSON", message: "Invalid request body" } }, 400)
  }

  if (body.confirmSlug !== slug) {
    return c.json({
      error: {
        code: "CONFIRMATION_MISMATCH",
        message: "Confirmation slug must exactly match the organization slug",
      },
    }, 400)
  }

  const orgConnections = await listConnectionsForOrg(org.id)
  const needsBrokerCredentials = orgConnections.some((connection) => (
    connection.secretStore === "ssm" && !!connection.secretPath
  ))

  if (needsBrokerCredentials && !org.iamRoleArn) {
    return c.json({
      error: {
        code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
        message: "Organization broker role is not configured",
      },
    }, 409)
  }

  let brokerCredentials: AwsSessionCredentials | undefined
  if (needsBrokerCredentials) {
    brokerCredentials = await getOrgBrokerCredentials(org)
  }

  for (const connection of orgConnections) {
    if (connection.secretStore === "ssm" && connection.secretPath) {
      await deleteConnectionSecret(connection.secretPath, { credentials: brokerCredentials })
    }
  }

  await db.transaction(async (tx) => {
    const deploymentRows = await tx
      .select({ id: workspaceDeployments.id })
      .from(workspaceDeployments)
      .where(eq(workspaceDeployments.orgId, org.id))
    const deploymentIds = deploymentRows.map((row) => row.id)

    if (deploymentIds.length > 0) {
      await tx.delete(approvals).where(inArray(approvals.deploymentId, deploymentIds))
    }

    await tx.delete(workspaces).where(eq(workspaces.orgId, org.id))

    if (deploymentIds.length > 0) {
      await tx.delete(tfRuns).where(inArray(tfRuns.deploymentId, deploymentIds))
    }

    await tx.delete(workspaceDeployments).where(eq(workspaceDeployments.orgId, org.id))
    await tx.delete(jobs).where(eq(jobs.orgId, org.id))
    await tx.delete(connections).where(eq(connections.orgId, org.id))

    await tx
      .update(githubInstallations)
      .set({ orgId: null })
      .where(eq(githubInstallations.orgId, org.id))

    await tx
      .update(repositories)
      .set({ orgId: null })
      .where(and(eq(repositories.orgId, org.id), isNotNull(repositories.installationId)))

    await tx
      .delete(repositories)
      .where(and(eq(repositories.orgId, org.id), isNull(repositories.installationId)))

    await tx.delete(organizations).where(eq(organizations.id, org.id))
  })

  if (org.kmsKeyArn || org.iamRoleArn) {
    await deprovisionOrgResources(org.id, org.kmsKeyArn ?? undefined, org.iamRoleArn ?? undefined)
  }

  return c.json({ data: { deleted: true } })
})

/**
 * GET /api/orgs
 *
 * List all organizations the current user belongs to.
 * This endpoint requires authentication but is NOT org-scoped (it lists all orgs).
 */
orgsRoute.get("/", async (c) => {
  const env = getEnv()

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  // In dev mode, return the single org from headers
  if (env.authMode === "dev" && auth.orgId && auth.role) {
    const orgSlug = c.req.header("x-yaffle-org") ?? auth.name
    return c.json({
      data: [
        {
          id: auth.orgId,
          slug: orgSlug,
          name: orgSlug,
          role: auth.role,
          source: "admin_bootstrap",
        },
      ],
    })
  }

  // Production mode - list from database
  const orgs = await listUserOrgs(auth.userId)
  return c.json({ data: orgs })
})

/**
 * GET /api/orgs/stream
 *
 * SSE stream for user's org list. Pushes updates when orgs change.
 */
orgsRoute.get("/stream", async (c) => {
  const token = c.req.query("token")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers, { token })
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const userId = auth.userId

  return streamSSE(c, async (stream) => {
    let lastPayload = ""
    let inFlight = false

    const sendSnapshot = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const orgs = await listUserOrgs(userId)
        const payload = JSON.stringify({ data: orgs })

        if (payload !== lastPayload) {
          lastPayload = payload
          await stream.writeSSE({ event: "update", data: payload })
        }
      } finally {
        inFlight = false
      }
    }

    await sendSnapshot()

    const interval = setInterval(sendSnapshot, 2000)

    // Block the callback so Hono doesn't call stream.close() in its
    // finally block.  Resolves only when the client disconnects.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(interval)
        resolve()
      })
    })
  })
})

/**
 * GET /api/orgs/:slug/status/stream
 *
 * SSE stream for org provisioning status. Pushes updates as the org
 * transitions through pending -> provisioning -> active/failed.
 */
orgsRoute.get("/:slug/status/stream", async (c) => {
  const slug = c.req.param("slug")
  const token = c.req.query("token")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers, { token })
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  // Find the org
  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  // Check membership
  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership) {
    return c.json({ error: { code: "FORBIDDEN", message: "Not a member of this organization" } }, 403)
  }

  return streamSSE(c, async (stream) => {
    let lastPayload = ""
    let inFlight = false

    const sendSnapshot = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        // Re-fetch org to get latest status
        const currentOrg = await findOrgBySlug(slug)
        if (!currentOrg) return

        const payload = JSON.stringify({
          data: {
            id: currentOrg.id,
            slug: currentOrg.slug,
            name: currentOrg.name,
            provisioningStatus: currentOrg.provisioningStatus,
            provisioningError: currentOrg.provisioningError,
            provisioningAttempts: currentOrg.provisioningAttempts,
          },
        })

        if (payload !== lastPayload) {
          lastPayload = payload
          await stream.writeSSE({ event: "update", data: payload })
        }
      } finally {
        inFlight = false
      }
    }

    await sendSnapshot()

    // Poll every 2s for status updates
    const interval = setInterval(sendSnapshot, 2000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(interval)
        resolve()
      })
    })
  })
})

/**
 * GET /api/orgs/:slug/connections
 *
 * List connections for an organization.
 */
orgsRoute.get("/:slug/connections", async (c) => {
  const slug = c.req.param("slug")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership) {
    return c.json({ error: { code: "FORBIDDEN", message: "Not a member of this organization" } }, 403)
  }

  const listStart = performance.now()
  const items = await withSpan("connections.list_inventory", async () => listConnectionsForOrg(org.id))
  const listDuration = performance.now() - listStart
  c.header("Server-Timing", appendServerTiming(c.res.headers.get("Server-Timing"), "connections_db", listDuration))

  return c.json({
    data: items.map((connection) => ({
      id: connection.id,
      name: connection.name,
      providerType: connection.providerType,
      credentialProviderType: connection.credentialProviderType,
      type: connection.type,
      config: connection.config,
      secretStore: connection.secretStore,
      secretPath: connection.secretPath,
      secretArn: connection.secretArn,
      lastValidatedAt: connection.lastValidatedAt,
      lastValidationError: connection.lastValidationError,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    })),
  })
})

orgsRoute.get("/:slug/connection-requirements", async (c) => {
  const slug = c.req.param("slug")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership) {
    return c.json({ error: { code: "FORBIDDEN", message: "Not a member of this organization" } }, 403)
  }

  const totalStart = performance.now()
  const dataLoadStart = performance.now()
  const [connections, deployments] = await withSpan("connections.requirements.load_data", async () =>
    Promise.all([
      listConnectionsForOrg(org.id),
      listLatestDeploymentsForOrg(org.id),
    ])
  )
  const dataLoadDuration = performance.now() - dataLoadStart

  const inferenceStart = performance.now()
  const requirements = await findMissingConnectionRequirements({
    deployments,
    connections,
  })
  const inferenceDuration = performance.now() - inferenceStart
  const totalDuration = performance.now() - totalStart

  let serverTiming = c.res.headers.get("Server-Timing")
  serverTiming = appendServerTiming(serverTiming, "req_load", dataLoadDuration)
  serverTiming = appendServerTiming(serverTiming, "req_infer", inferenceDuration)
  serverTiming = appendServerTiming(serverTiming, "req_total", totalDuration)
  c.header("Server-Timing", serverTiming)

  return c.json({ data: requirements })
})

orgsRoute.get("/:slug/aws-bootstrap-principal", async (c) => {
  const slug = c.req.param("slug")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership) {
    return c.json({ error: { code: "FORBIDDEN", message: "Not a member of this organization" } }, 403)
  }

  if (!org.iamRoleArn) {
    return c.json(
      {
        error: {
          code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
          message: "Organization broker role is not configured",
        },
      },
      409,
    )
  }

  return c.json({
    data: {
      principalArn: org.iamRoleArn,
    },
  })
})

orgsRoute.get("/:slug/provider-credential-signatures", async (c) => {
  const slug = c.req.param("slug")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership) {
    return c.json({ error: { code: "FORBIDDEN", message: "Not a member of this organization" } }, 403)
  }

  const signatures = await listActiveProviderCredentialSignatures()

  return c.json({
    data: signatures.map((signature) => ({
      providerType: signature.providerType,
      displayName: signature.displayName,
      suggestedCredentialProviderType: signature.suggestedCredentialProviderType,
      exactEnvVars: signature.exactEnvVars,
      prefixEnvVars: signature.prefixEnvVars,
    })),
  })
})

orgsRoute.get("/:slug/connections/:connectionId", async (c) => {
  const slug = c.req.param("slug")
  const connectionId = c.req.param("connectionId")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership || membership.role !== "admin") {
    return c.json({ error: { code: "FORBIDDEN", message: "Only org admins can view connection details" } }, 403)
  }

  const connection = await findConnectionById(connectionId)
  if (!connection || connection.orgId !== org.id) {
    return c.json({ error: { code: "NOT_FOUND", message: "Connection not found" } }, 404)
  }

  const config = typeof connection.config === "object" && connection.config !== null
    ? connection.config as Record<string, unknown>
    : {}

  let secret: unknown = null
  if (connection.credentialProviderType === "envvar" && connection.secretPath) {
    if (!org.iamRoleArn) {
      return c.json(
        {
          error: {
            code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
            message: "Organization broker role is not configured",
          },
        },
        409,
      )
    }

    const brokerCredentials = await getOrgBrokerCredentials(org)
    secret = await getConnectionSecret(connection.secretPath, { credentials: brokerCredentials })
  }

  return c.json({
    data: {
      id: connection.id,
      name: connection.name,
      providerType: connection.providerType,
      credentialProviderType: connection.credentialProviderType,
      config,
      secret,
    },
  })
})

orgsRoute.delete("/:slug/connections/:connectionId", async (c) => {
  const slug = c.req.param("slug")
  const connectionId = c.req.param("connectionId")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership || membership.role !== "admin") {
    return c.json({ error: { code: "FORBIDDEN", message: "Only org admins can delete connections" } }, 403)
  }

  const connection = await findConnectionById(connectionId)
  if (!connection || connection.orgId !== org.id) {
    return c.json({ error: { code: "NOT_FOUND", message: "Connection not found" } }, 404)
  }

  if (connection.secretStore === "ssm" && connection.secretPath) {
    if (!org.iamRoleArn) {
      return c.json(
        {
          error: {
            code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
            message: "Organization broker role is not configured",
          },
        },
        409,
      )
    }

    const brokerCredentials = await getOrgBrokerCredentials(org)
    await deleteConnectionSecret(connection.secretPath, { credentials: brokerCredentials })
  }

  if (connection.credentialProviderType === "iam_role") {
    if (!org.iamRoleArn) {
      return c.json(
        {
          error: {
            code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
            message: "Organization broker role is not configured",
          },
        },
        409,
      )
    }

    const orgConnections = await listConnectionsForOrg(org.id)
    const nextTargets = listIamRoleTargets(orgConnections.filter((item) => item.id !== connection.id))

    if (!org.kmsKeyArn) {
      return c.json(
        {
          error: {
            code: "ORG_KMS_NOT_CONFIGURED",
            message: "Organization does not have a KMS key configured for connection secrets",
          },
        },
        409,
      )
    }

    await syncOrgBrokerRoleAssumeTargets(org.id, slug, org.iamRoleArn, org.kmsKeyArn, nextTargets)
  }

  await deleteConnection(connection.id)

  return c.json({ data: { success: true } })
})

/**
 * POST /api/orgs/:slug/connections
 *
 * Create a connection for an organization.
 */
orgsRoute.post("/:slug/connections", async (c) => {
  const slug = c.req.param("slug")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership) {
    return c.json({ error: { code: "FORBIDDEN", message: "Not a member of this organization" } }, 403)
  }

  if (membership.role !== "admin") {
    return c.json({ error: { code: "FORBIDDEN", message: "Only org admins can create connections" } }, 403)
  }

  const body = await c.req.json()
  const parsed = createConnectionSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid connection payload", details: parsed.error.issues } },
      400,
    )
  }

  const connectionId = uuidv7()
  const payload = parsed.data
  const resolvedProviderType = await resolveConnectionProviderType(payload)
  const providerInference = buildProviderInferenceMetadata(payload, resolvedProviderType)

  const scopeSummary = buildScopeSummary(payload.environmentScope, payload.workspaceScope)

  const desiredScope: ConnectionScopeConfig = {
    providerType: resolvedProviderType,
    environmentScope: payload.environmentScope,
    workspaceScope: payload.workspaceScope,
  }

  const existingConnections = await listConnectionsForOrg(org.id)
  const conflictingConnection = existingConnections.find((connection) =>
    connectionScopesOverlap(connection, desiredScope)
  )

  if (conflictingConnection) {
    return c.json(
      {
        error: {
          code: "CONNECTION_SCOPE_CONFLICT",
          message: `Connection overlaps with existing ${conflictingConnection.name}. Only one ${resolvedProviderType} connection may match a given environment/workspace scope.`,
        },
      },
      409,
    )
  }

  if (!org.kmsKeyArn) {
    return c.json(
      {
        error: {
          code: "ORG_KMS_NOT_CONFIGURED",
          message: "Organization does not have a KMS key configured for connection secrets",
        },
      },
      409,
    )
  }

  let secretArn: string
  let config: Record<string, unknown>
  let type: string

  if (payload.credentialProviderType === "envvar") {
    const cloudflareTokenError = await validateCloudflareApiToken(resolvedProviderType, payload.envVars)
    if (cloudflareTokenError) {
      return c.json(
        {
          error: {
            code: cloudflareTokenError.code,
            message: cloudflareTokenError.message,
          },
        },
        cloudflareTokenError.status,
      )
    }

    if (!org.iamRoleArn) {
      return c.json(
        {
          error: {
            code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
            message: "Organization broker role is not configured",
          },
        },
        409,
      )
    }

    const brokerCredentials = await getOrgBrokerCredentials(org)
    const stored = await storeConnectionSecret(org.id, slug, connectionId, org.kmsKeyArn, {
      envVars: payload.envVars,
    }, {
      credentials: brokerCredentials,
    })

    secretArn = stored.arn
    type = "envvar"
    config = {
      providerType: resolvedProviderType,
      credentialProviderType: "envvar",
      environmentScope: payload.environmentScope,
      workspaceScope: payload.workspaceScope,
      scopeSummary,
      envVarKeys: payload.envVars.map((entry) => entry.key),
      providerInference,
      note: `Injects ${payload.envVars.length} environment variable${payload.envVars.length === 1 ? "" : "s"} at runtime.`,
      backingStore: "ssm_parameter_store",
    }
  } else {
    secretArn = `iam-role:${payload.roleArn}`
    type = "iam_role"
    config = {
      providerType: resolvedProviderType,
      credentialProviderType: "iam_role",
      environmentScope: payload.environmentScope,
      workspaceScope: payload.workspaceScope,
      scopeSummary,
      roleArn: payload.roleArn,
      externalId: payload.externalId ?? null,
      note: "Assumes an AWS IAM role and mints short-lived STS credentials.",
      backingStore: "inline-config",
    }

    if (!org.iamRoleArn) {
      return c.json(
        {
          error: {
            code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
            message: "Organization broker role is not configured",
          },
        },
        409,
      )
    }

    const nextTargets = listIamRoleTargets(existingConnections)
    nextTargets.push(payload.roleArn)
    await syncOrgBrokerRoleAssumeTargets(org.id, slug, org.iamRoleArn, org.kmsKeyArn, nextTargets)
  }

  const connection = await createConnection({
    id: connectionId,
    orgId: org.id,
    name: payload.name,
    providerType: resolvedProviderType,
    credentialProviderType: payload.credentialProviderType,
    type,
    config,
    secretStore: payload.credentialProviderType === "envvar" ? "ssm" : null,
    secretPath: payload.credentialProviderType === "envvar"
      ? `/yaffle/org/${slug}/connections/${connectionId}/secret`
      : null,
    secretArn,
    lastValidatedAt: new Date(),
    lastValidationError: null,
  })

  return c.json({
    data: {
      id: connection.id,
      name: connection.name,
      providerType: connection.providerType,
      credentialProviderType: connection.credentialProviderType,
      type: connection.type,
      config: connection.config,
      secretStore: connection.secretStore,
      secretPath: connection.secretPath,
      secretArn: connection.secretArn,
      lastValidatedAt: connection.lastValidatedAt,
      lastValidationError: connection.lastValidationError,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    },
  }, 201)
})

orgsRoute.patch("/:slug/connections/:connectionId", async (c) => {
  const slug = c.req.param("slug")
  const connectionId = c.req.param("connectionId")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership || membership.role !== "admin") {
    return c.json({ error: { code: "FORBIDDEN", message: "Only org admins can update connections" } }, 403)
  }

  const existing = await findConnectionById(connectionId)
  if (!existing || existing.orgId !== org.id) {
    return c.json({ error: { code: "NOT_FOUND", message: "Connection not found" } }, 404)
  }

  const body = await c.req.json()
  const parsed = createConnectionSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Invalid connection payload", details: parsed.error.issues } },
      400,
    )
  }

  const payload = parsed.data
  const resolvedProviderType = await resolveConnectionProviderType(payload)
  const providerInference = buildProviderInferenceMetadata(payload, resolvedProviderType)

  if (payload.credentialProviderType !== existing.credentialProviderType) {
    return c.json(
      {
        error: {
          code: "CONNECTION_PROVIDER_TYPE_IMMUTABLE",
          message: "Credential provider type cannot be changed in place. Create a new connection instead.",
        },
      },
      409,
    )
  }

  const scopeSummary = buildScopeSummary(payload.environmentScope, payload.workspaceScope)
  const desiredScope: ConnectionScopeConfig = {
    providerType: resolvedProviderType,
    environmentScope: payload.environmentScope,
    workspaceScope: payload.workspaceScope,
  }

  const existingConnections = await listConnectionsForOrg(org.id)
  const conflictingConnection = existingConnections.find((connection) =>
    connection.id !== existing.id && connectionScopesOverlap(connection, desiredScope)
  )

  if (conflictingConnection) {
    return c.json(
      {
        error: {
          code: "CONNECTION_SCOPE_CONFLICT",
          message: `Connection overlaps with existing ${conflictingConnection.name}. Only one ${resolvedProviderType} connection may match a given environment/workspace scope.`,
        },
      },
      409,
    )
  }

  let secretArn = existing.secretArn
  let secretStore = existing.secretStore
  let secretPath = existing.secretPath
  let type = existing.type
  let config: Record<string, unknown>

  if (payload.credentialProviderType === "envvar") {
    const cloudflareTokenError = await validateCloudflareApiToken(resolvedProviderType, payload.envVars)
    if (cloudflareTokenError) {
      return c.json(
        {
          error: {
            code: cloudflareTokenError.code,
            message: cloudflareTokenError.message,
          },
        },
        cloudflareTokenError.status,
      )
    }

    if (!org.kmsKeyArn) {
      return c.json(
        {
          error: {
            code: "ORG_KMS_NOT_CONFIGURED",
            message: "Organization does not have a KMS key configured for connection secrets",
          },
        },
        409,
      )
    }

    if (!org.iamRoleArn) {
      return c.json(
        {
          error: {
            code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
            message: "Organization broker role is not configured",
          },
        },
        409,
      )
    }

    const brokerCredentials = await getOrgBrokerCredentials(org)
    const stored = await storeConnectionSecret(org.id, slug, existing.id, org.kmsKeyArn, {
      envVars: payload.envVars,
    }, {
      credentials: brokerCredentials,
    })

    secretArn = stored.arn
    secretStore = stored.store
    secretPath = stored.path
    type = "envvar"
    config = {
      providerType: resolvedProviderType,
      credentialProviderType: "envvar",
      environmentScope: payload.environmentScope,
      workspaceScope: payload.workspaceScope,
      scopeSummary,
      envVarKeys: payload.envVars.map((entry) => entry.key),
      providerInference,
      note: `Injects ${payload.envVars.length} environment variable${payload.envVars.length === 1 ? "" : "s"} at runtime.`,
      backingStore: "ssm_parameter_store",
    }
  } else {
    secretArn = `iam-role:${payload.roleArn}`
    secretStore = "inline-config"
    secretPath = null
    type = "iam_role"
    config = {
      providerType: resolvedProviderType,
      credentialProviderType: "iam_role",
      environmentScope: payload.environmentScope,
      workspaceScope: payload.workspaceScope,
      scopeSummary,
      roleArn: payload.roleArn,
      externalId: payload.externalId ?? null,
      note: "Assumes an AWS IAM role and mints short-lived STS credentials.",
      backingStore: "inline-config",
    }

    if (!org.iamRoleArn) {
      return c.json(
        {
          error: {
            code: "ORG_BROKER_ROLE_NOT_CONFIGURED",
            message: "Organization broker role is not configured",
          },
        },
        409,
      )
    }

    const nextConnections = existingConnections.map((item) => {
      if (item.id !== existing.id) {
        return item
      }

      return {
        ...item,
        config: {
          ...(typeof item.config === "object" && item.config !== null ? item.config as Record<string, unknown> : {}),
          roleArn: payload.roleArn,
        },
      }
    })
    const nextTargets = listIamRoleTargets(nextConnections)
    if (!org.kmsKeyArn) {
      return c.json(
        {
          error: {
            code: "ORG_KMS_NOT_CONFIGURED",
            message: "Organization does not have a KMS key configured for connection secrets",
          },
        },
        409,
      )
    }

    await syncOrgBrokerRoleAssumeTargets(org.id, slug, org.iamRoleArn, org.kmsKeyArn, nextTargets)
  }

  const connection = await updateConnection(existing.id, {
    name: payload.name,
    providerType: resolvedProviderType,
    credentialProviderType: payload.credentialProviderType,
    type,
    config,
    secretStore,
    secretPath,
    secretArn,
    lastValidatedAt: new Date(),
    lastValidationError: null,
  })

  return c.json({
    data: connection,
  })
})
