import { randomBytes, timingSafeEqual } from "node:crypto"

import { Hono, type MiddlewareHandler } from "hono"
import { z } from "zod"

import {
  consumeLifecycleCompletionToken,
  createLifecycleEvent,
  createLifecycleItem,
  createLifecycleRun,
  findLifecycleRunById,
  findLifecycleItemById,
  getLatestLifecycleState,
  issueLifecycleCompletionToken,
  updateLifecycleItem,
  updateLifecycleRun,
} from "../db/queries/lifecycle.ts"
import { findEnvironmentPolicy } from "../db/queries/environment-policies.ts"
import { ensurePrincipalRepoBinding, findPrincipalRepoBindingById } from "../db/queries/principals.ts"
import { findOrgMembership, findOrgById } from "../db/queries/organizations.ts"
import { findRepoByFullName } from "../db/queries/repositories.ts"
import { buildPublicUrl } from "../lib/public-origin.ts"
import { principalAuth, type PrincipalAuthContext } from "../middleware/principal-auth.ts"
import { enforceRateLimit, readRequestBodyText, RequestBodyTooLargeError } from "../lib/request-protection.ts"

type PrincipalVariables = {
  principalAuth: PrincipalAuthContext
}

const LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR = "YAFFLE_LOCAL_FIRST_FEATURE_TOKEN"
const LIFECYCLE_BODY_MAX_BYTES = 64 * 1024

const lifecycleCreateRateLimit = {
  bucket: "lifecycle-create",
  limit: 120,
  windowMs: 60_000,
} as const

const lifecycleCallbackRateLimit = {
  bucket: "lifecycle-callback",
  limit: 240,
  windowMs: 60_000,
} as const

const createRunSchema = z.object({
  canonicalRepoNamespace: z.string().min(1),
  localRepoFingerprint: z.string().min(1),
  environmentName: z.string().min(1),
  executionMode: z.enum(["local", "cloud"]),
})

const admissionSchema = createRunSchema

const createItemSchema = z.object({
  runId: z.string().uuid(),
  workspacePath: z.string().min(1),
  key: z.string().min(1),
  phase: z.enum(["activation", "verification"]),
  kind: z.literal("webhook"),
  failurePolicy: z.enum(["failed", "degraded"]),
  scopes: z.array(z.string().min(1)).min(1),
  destinationUrl: z.string().url(),
  destinationClass: z.enum(["public", "private_local"]),
  dispatchMode: z.enum(["local", "cloud"]),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  callbackTtlMinutes: z.number().int().positive().max(24 * 60).default(60),
})

const callbackBodySchema = z.object({
  status: z.enum(["running", "succeeded", "degraded", "failed"]),
  summary: z.string().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const lifecycleRoute = new Hono<{ Variables: PrincipalVariables }>()

const enforceFeatureToken: MiddlewareHandler = async (c, next) => {
  const expectedToken = process.env[LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR]?.trim()
  if (!expectedToken) {
    return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404)
  }

  const providedToken = c.req.header("feature-token")?.trim() ?? ""
  const expected = Buffer.from(expectedToken)
  const provided = Buffer.from(providedToken)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return c.json(
      { error: { code: "INVALID_FEATURE_TOKEN", message: "invalid feature token" } },
      403,
    )
  }

  return next()
}

function enforceRouteRateLimit(options: { bucket: string; limit: number; windowMs: number }): MiddlewareHandler {
  return async (c, next) => {
    const response = enforceRateLimit(c, options)
    if (response) {
      return response
    }
    return next()
  }
}

lifecycleRoute.use("/runs", enforceFeatureToken)
lifecycleRoute.use("/items", enforceFeatureToken)
lifecycleRoute.use("/state", enforceFeatureToken)
lifecycleRoute.use("/runs", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/items", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/state", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/runs", principalAuth())
lifecycleRoute.use("/items", principalAuth())
lifecycleRoute.use("/state", principalAuth())
lifecycleRoute.use("/admission", enforceFeatureToken)
lifecycleRoute.use("/admission", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/admission", principalAuth())

lifecycleRoute.post("/admission", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }
  const parsed = admissionSchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json({ error: { code: "INVALID_REQUEST", message: parsed.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const body = parsed.data
  const decision = await evaluateEnvironmentAdmission(principal, body.canonicalRepoNamespace, {
    environmentName: body.environmentName,
    executionMode: body.executionMode,
  })

  return c.json({ data: decision })
})

lifecycleRoute.post("/runs", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }
  const parsed = createRunSchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json({ error: { code: "INVALID_REQUEST", message: parsed.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const body = parsed.data
  const binding = await ensurePrincipalRepoBinding({
    principalId: principal.principalId,
    canonicalRepoNamespace: body.canonicalRepoNamespace,
    localRepoFingerprint: body.localRepoFingerprint,
  })
  const run = await createLifecycleRun({
    principalId: principal.principalId,
    repoBindingId: binding.id,
    environmentName: body.environmentName,
    executionMode: body.executionMode,
  })

  return c.json({
    data: {
      id: run.id,
      repoBindingId: run.repoBindingId,
      environmentName: run.environmentName,
      executionMode: run.executionMode,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
    },
  }, 201)
})

lifecycleRoute.post("/items", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }
  const parsed = createItemSchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json({ error: { code: "INVALID_REQUEST", message: parsed.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const body = parsed.data
  const run = await findLifecycleRunById(body.runId)
  if (!run || run.principalId !== principal.principalId) {
    return c.json({ error: { code: "NOT_FOUND", message: "lifecycle run not found" } }, 404)
  }

  const resolvedBinding = await findPrincipalRepoBindingById(run.repoBindingId)
  if (!resolvedBinding) {
    return c.json({ error: { code: "NOT_FOUND", message: "repo binding not found" } }, 404)
  }

  const governance = await evaluateLifecycleGovernance(principal, resolvedBinding.canonicalRepoNamespace, {
    environmentName: run.environmentName,
    destinationClass: body.destinationClass,
    dispatchMode: body.dispatchMode,
  })

  if (!governance.allowed) {
    const blockedItem = await createLifecycleItem({
      runId: body.runId,
      workspacePath: body.workspacePath,
      key: body.key,
      phase: body.phase,
      kind: body.kind,
      state: "blocked",
      failurePolicy: body.failurePolicy,
      scopes: body.scopes,
      destinationUrl: body.destinationUrl,
      destinationClass: body.destinationClass,
      dispatchMode: body.dispatchMode,
      summary: "Blocked by environment governance policy",
      reason: governance.reason,
      metadata: body.metadata ?? {},
    })
    await createLifecycleEvent({
      itemId: blockedItem.id,
      eventType: "blocked",
      payload: {
        principalId: principal.principalId,
        workspacePath: body.workspacePath,
        key: body.key,
        phase: body.phase,
        reason: governance.reason,
      },
    })

    return c.json({
      data: {
        id: blockedItem.id,
        state: blockedItem.state,
        onCompletionUrl: null,
      },
    }, 201)
  }

  const item = await createLifecycleItem({
    runId: body.runId,
    workspacePath: body.workspacePath,
    key: body.key,
    phase: body.phase,
    kind: body.kind,
    state: "pending",
    failurePolicy: body.failurePolicy,
    scopes: body.scopes,
    destinationUrl: body.destinationUrl,
    destinationClass: body.destinationClass,
    dispatchMode: body.dispatchMode,
    summary: body.summary,
    metadata: body.metadata ?? {},
  })
  await createLifecycleEvent({
    itemId: item.id,
    eventType: "created",
    payload: {
      principalId: principal.principalId,
      workspacePath: body.workspacePath,
      key: body.key,
      phase: body.phase,
    },
  })

  const callbackToken = randomBytes(32).toString("base64url")
  await issueLifecycleCompletionToken({
    token: callbackToken,
    itemId: item.id,
    expiresAt: new Date(Date.now() + body.callbackTtlMinutes * 60 * 1000),
  })

  return c.json({
    data: {
      id: item.id,
      state: item.state,
      onCompletionUrl: buildPublicUrl(c.req.url, `/api/lifecycle/completions/${callbackToken}`),
    },
  }, 201)
})

lifecycleRoute.get("/items/:itemId", async (c) => {
  const item = await findLifecycleItemById(c.req.param("itemId"))
  if (!item) {
    return c.json({ error: { code: "NOT_FOUND", message: "lifecycle item not found" } }, 404)
  }

  return c.json({
    data: {
      id: item.id,
      runId: item.runId,
      workspacePath: item.workspacePath,
      key: item.key,
      phase: item.phase,
      state: item.state,
      summary: item.summary,
      reason: item.reason,
      metadata: item.metadata,
      startedAt: item.startedAt?.toISOString() ?? null,
      finishedAt: item.finishedAt?.toISOString() ?? null,
    },
  })
})

lifecycleRoute.get("/state", async (c) => {
  const principal = c.get("principalAuth")
  const canonicalRepoNamespace = c.req.query("canonicalRepoNamespace")
  const localRepoFingerprint = c.req.query("localRepoFingerprint")
  const environmentName = c.req.query("environmentName")
  if (!canonicalRepoNamespace || !localRepoFingerprint || !environmentName) {
    return c.json({ error: { code: "INVALID_REQUEST", message: "canonicalRepoNamespace, localRepoFingerprint, and environmentName are required" } }, 400)
  }

  const binding = await ensurePrincipalRepoBinding({
    principalId: principal.principalId,
    canonicalRepoNamespace,
    localRepoFingerprint,
  })
  const state = await getLatestLifecycleState({
    repoBindingId: binding.id,
    environmentName,
  })

  return c.json({
    data: state
      ? {
          run: {
            id: state.run.id,
            status: state.run.status,
            executionMode: state.run.executionMode,
            startedAt: state.run.startedAt.toISOString(),
            finishedAt: state.run.finishedAt?.toISOString() ?? null,
          },
          items: state.items.map((item) => ({
            id: item.id,
            workspacePath: item.workspacePath,
            key: item.key,
            phase: item.phase,
            state: item.state,
            failurePolicy: item.failurePolicy,
            scopes: item.scopes,
            summary: item.summary,
            reason: item.reason,
            metadata: item.metadata,
            startedAt: item.startedAt?.toISOString() ?? null,
            finishedAt: item.finishedAt?.toISOString() ?? null,
          })),
        }
      : null,
  })
})

lifecycleRoute.use("/completions/*", enforceRouteRateLimit(lifecycleCallbackRateLimit))

lifecycleRoute.post("/completions/:token", async (c) => {
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }
  const parsed = callbackBodySchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json({ error: { code: "INVALID_REQUEST", message: parsed.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const consumed = await consumeLifecycleCompletionToken(c.req.param("token"))
  if (!consumed) {
    return c.json({ error: { code: "INVALID_TOKEN", message: "lifecycle completion token is invalid or expired" } }, 404)
  }

  const body = parsed.data
  const item = await updateLifecycleItem(consumed.item.id, {
    state: body.status,
    summary: body.summary,
    reason: body.reason,
    metadata: body.metadata ?? {},
    startedAt: consumed.item.startedAt ?? new Date(),
    finishedAt: ["succeeded", "degraded", "failed"].includes(body.status) ? new Date() : null,
  })
  await createLifecycleEvent({
    itemId: consumed.item.id,
    eventType: "callback",
    payload: {
      status: body.status,
      summary: body.summary,
      reason: body.reason,
      metadata: body.metadata ?? {},
    },
  })

  if (item && ["succeeded", "degraded", "failed"].includes(item.state)) {
    const state = await getLatestLifecycleState({
      repoBindingId: consumed.run.repoBindingId,
      environmentName: consumed.run.environmentName,
    })
    if (state) {
      const finalStatus = state.items.some((entry) => entry.state === "failed")
        ? "failed"
        : state.items.some((entry) => entry.state === "degraded")
          ? "degraded"
          : state.items.every((entry) => entry.state === "succeeded")
            ? "succeeded"
            : "running"
      await updateLifecycleRun(consumed.run.id, {
        status: finalStatus,
        finishedAt: finalStatus === "running" ? null : new Date(),
      })
    }
  }

  return c.json({ data: { id: consumed.item.id, state: item?.state ?? body.status } })
})

async function readJsonBody(request: Request): Promise<unknown | Response> {
  try {
    const body = await readRequestBodyText(request, LIFECYCLE_BODY_MAX_BYTES)
    return body ? JSON.parse(body) : {}
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response(
        JSON.stringify({
          error: {
            code: "REQUEST_TOO_LARGE",
            message: `request body exceeds ${error.maxBytes} bytes`,
          },
        }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response(
      JSON.stringify({ error: { code: "INVALID_REQUEST", message: "request body must be valid JSON" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }
}

type PrincipalTier = "anonymous" | "free_local" | "paid_cloud"

async function evaluateLifecycleGovernance(
  principal: PrincipalAuthContext,
  canonicalRepoNamespace: string,
  values: {
    environmentName: string
    destinationClass: "public" | "private_local"
    dispatchMode: "local" | "cloud"
  },
): Promise<{ allowed: boolean; reason?: string }> {
  const admission = await evaluateEnvironmentAdmission(principal, canonicalRepoNamespace, {
    environmentName: values.environmentName,
    executionMode: values.dispatchMode,
  })
  if (!admission.allowed) {
    return admission
  }

  const policyContext = await resolveEnvironmentPolicyContext(canonicalRepoNamespace, values.environmentName)
  if (!policyContext.policy) {
    return { allowed: true }
  }

  if (!policyContext.policy.allowedDestinationClasses.includes(values.destinationClass)) {
    return {
      allowed: false,
      reason: `Environment '${values.environmentName}' does not allow '${values.destinationClass}' lifecycle destinations.`,
    }
  }

  return { allowed: true }
}

async function evaluateEnvironmentAdmission(
  principal: PrincipalAuthContext,
  canonicalRepoNamespace: string,
  values: {
    environmentName: string
    executionMode: "local" | "cloud"
  },
): Promise<{ allowed: boolean; reason?: string }> {
  const policyContext = await resolveEnvironmentPolicyContext(
    canonicalRepoNamespace,
    values.environmentName,
  )
  if (!policyContext.policy || !policyContext.orgId) {
    return { allowed: true }
  }

  const principalTier = await resolvePrincipalTier(principal, policyContext.orgId)
  if (principalTierRank(principalTier) < principalTierRank(policyContext.policy.minimumPrincipalTier as PrincipalTier)) {
    return {
      allowed: false,
      reason: `Environment '${values.environmentName}' requires principal tier '${policyContext.policy.minimumPrincipalTier}', but this run is '${principalTier}'.`,
    }
  }

  if (policyContext.policy.lifecycleDispatch === "central" && values.executionMode !== "cloud") {
    return {
      allowed: false,
      reason: `Environment '${values.environmentName}' requires central execution for governed runs, but this run is '${values.executionMode}'.`,
    }
  }

  return { allowed: true }
}

async function resolveEnvironmentPolicyContext(
  canonicalRepoNamespace: string,
  environmentName: string,
): Promise<{ repoFullName: string | null; orgId: string | null; policy: Awaited<ReturnType<typeof findEnvironmentPolicy>> }> {
  const repoFullName = repo_full_name_from_namespace(canonicalRepoNamespace)
  if (!repoFullName) {
    return { repoFullName: null, orgId: null, policy: undefined }
  }

  const repo = await findRepoByFullName(repoFullName)
  if (!repo?.orgId) {
    return { repoFullName, orgId: null, policy: undefined }
  }

  const policy = await findEnvironmentPolicy({
    orgId: repo.orgId,
    repoFullName,
    environmentName,
  })
  return { repoFullName, orgId: repo.orgId, policy }
}

async function resolvePrincipalTier(
  principal: PrincipalAuthContext,
  orgId: string,
): Promise<PrincipalTier> {
  if (principal.type === "anonymous_session") {
    return "anonymous"
  }
  if (!principal.userId) {
    return "free_local"
  }

  const membership = await findOrgMembership(orgId, principal.userId)
  if (!membership) {
    return "free_local"
  }
  const org = await findOrgById(orgId)
  if (org && org.planTier !== "free" && ["active", "trialing"].includes(org.subscriptionStatus)) {
    return "paid_cloud"
  }

  return "free_local"
}

function principalTierRank(tier: PrincipalTier): number {
  switch (tier) {
    case "anonymous":
      return 0
    case "free_local":
      return 1
    case "paid_cloud":
      return 2
  }
}

function repo_full_name_from_namespace(canonicalRepoNamespace: string): string | null {
  const [owner, repo] = canonicalRepoNamespace.split("--")
  if (!owner || !repo) {
    return null
  }
  return `${owner}/${repo}`
}
