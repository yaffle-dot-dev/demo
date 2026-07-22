import { createHmac, randomBytes, randomUUID } from "node:crypto"

import { Hono, type MiddlewareHandler } from "hono"
import { z } from "zod"

import {
  type LifecycleEvent,
  type LifecycleItem,
  type LifecycleRun,
  claimLifecycleItemForDispatch,
  consumeLifecycleCompletionToken,
  createLifecycleEvent,
  createLifecycleItem,
  createLifecycleRun,
  findLifecycleItemById,
  findLifecycleItemForPrincipal,
  findLifecycleRunById,
  getLatestLifecycleState,
  issueLifecycleCompletionToken,
  listLifecycleEventsForItems,
  updateLifecycleItem,
  updateLifecycleRun,
} from "../db/queries/lifecycle.ts"
import { findConnectionsByName } from "../db/queries/connections.ts"
import { findEnvironmentPolicy } from "../db/queries/environment-policies.ts"
import { findDeploymentByRunGroupAndWorkspacePath } from "../db/queries/workspace-deployments.ts"
import {
  ensurePrincipalRepoBinding,
  findPrincipalRepoBindingById,
} from "../db/queries/principals.ts"
import { findOrgMembership, findOrgById } from "../db/queries/organizations.ts"
import { findRepoByFullName } from "../db/queries/repositories.ts"
import { getConnectionSecret } from "../lib/connection-secrets.ts"
import { OutputSelectionError, selectTerraformOutputs } from "../lib/output-selection.ts"
import { getInstallationOctokit } from "../lib/github.ts"
import {
  dispatchHostedLifecycleVerificationIfReady,
  reconcileHostedDeploymentState,
} from "../lib/hosted-lifecycle.ts"
import { assumeOrgBrokerRole } from "../lib/org-broker-auth.ts"
import { buildPublicUrl } from "../lib/public-origin.ts"
import {
  postPublicLifecycleWebhook,
  resolvePublicLifecycleDestination,
} from "../lib/lifecycle-http-dispatch.ts"
import { getConnectionScopeConfig, scopeListAllows } from "../lib/connection-scope.ts"
import { principalAuth, type PrincipalAuthContext } from "../middleware/principal-auth.ts"
import {
  enforceRateLimit,
  readRequestBodyText,
  RequestBodyTooLargeError,
} from "../lib/request-protection.ts"

type PrincipalVariables = {
  principalAuth: PrincipalAuthContext
}

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

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol
      return protocol === "http:" || protocol === "https:"
    } catch {
      return false
    }
  }, "must be an http(s) URL")

const createRunSchema = z.object({
  canonicalRepoNamespace: z.string().min(1),
  localRepoFingerprint: z.string().min(1),
  environmentName: z.string().min(1),
  executionMode: z.literal("local"),
})

const admissionSchema = createRunSchema.extend({
  executionMode: z.enum(["local", "cloud"]),
})

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
  dispatchMode: z.literal("local"),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  selectedOutputNames: z.array(z.string().min(1)),
  callbackTtlMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .default(60),
})

const genericLifecycleDispatchSchema = z.object({
  kind: z.literal("generic"),
  request: z.object({
    url: z.string().url(),
    method: z.literal("POST"),
    auth: z
      .object({
        scheme: z.enum(["bearer", "hmac_sha256"]),
        connection: z.string().min(1),
      })
      .optional(),
  }),
})

const githubRepositoryDispatchSchema = z.object({
  kind: z.literal("github_repository_dispatch"),
  github: z.object({
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    eventType: z.string().min(1),
    apiUrl: z.never().optional(),
  }),
})

const dispatchRequestSchema = z.object({
  runId: z.string().uuid(),
  itemId: z.string().uuid(),
  environmentName: z.string().min(1),
  workspacePath: z.string().min(1),
  phase: z.enum(["activation", "verification"]),
  dispatch: z.discriminatedUnion("kind", [
    genericLifecycleDispatchSchema,
    githubRepositoryDispatchSchema,
  ]),
  payload: z
    .object({
      repo_namespace: z.string().min(1),
      environment: z.string().min(1),
      workspace_path: z.string().min(1),
      item_key: z.string().min(1),
      phase: z.enum(["activation", "verification"]),
      outputs: z.record(z.unknown()),
      on_completion: z.string().url().nullable().optional(),
      git_sha: z.string().optional(),
      git_base_sha: z.string().optional(),
      git_branch: z.string().optional(),
    })
    .passthrough(),
})

type LifecycleDispatchRequest = z.infer<typeof dispatchRequestSchema>
type GenericLifecycleDispatchRequest = Omit<LifecycleDispatchRequest, "dispatch"> & {
  dispatch: z.infer<typeof genericLifecycleDispatchSchema>
}
type GitHubRepositoryDispatchRequest = Omit<LifecycleDispatchRequest, "dispatch"> & {
  dispatch: z.infer<typeof githubRepositoryDispatchSchema>
}

const callbackBodySchema = z.object({
  status: z.enum(["running", "succeeded", "degraded", "failed"]),
  summary: z.string().optional(),
  reason: z.string().optional(),
  externalUrl: httpUrlSchema.optional(),
})

export const lifecycleRoute = new Hono<{ Variables: PrincipalVariables }>()

function enforceRouteRateLimit(options: {
  bucket: string
  limit: number
  windowMs: number
}): MiddlewareHandler {
  return async (c, next) => {
    const response = enforceRateLimit(c, options)
    if (response) {
      return response
    }
    return next()
  }
}

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mergeCallbackMetadata(
  existingMetadata: unknown,
  externalUrl: string | undefined,
): Record<string, unknown> {
  return {
    ...recordFromJson(existingMetadata),
    ...(externalUrl ? { externalUrl } : {}),
  }
}

lifecycleRoute.use("/runs", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/items", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/state", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/runs", principalAuth())
lifecycleRoute.use("/items", principalAuth())
lifecycleRoute.use("/items/*", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/items/*", principalAuth())
lifecycleRoute.use("/state", principalAuth())
lifecycleRoute.use("/admission", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/admission", principalAuth())
lifecycleRoute.use("/dispatch", enforceRouteRateLimit(lifecycleCreateRateLimit))
lifecycleRoute.use("/dispatch", principalAuth())

lifecycleRoute.post("/admission", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }
  const parsed = admissionSchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: parsed.error.errors[0]?.message ?? "invalid request",
        },
      },
      400,
    )
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
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: parsed.error.errors[0]?.message ?? "invalid request",
        },
      },
      400,
    )
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

  return c.json(
    {
      data: {
        id: run.id,
        repoBindingId: run.repoBindingId,
        environmentName: run.environmentName,
        executionMode: run.executionMode,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
      },
    },
    201,
  )
})

lifecycleRoute.post("/items", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }
  const parsed = createItemSchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: parsed.error.errors[0]?.message ?? "invalid request",
        },
      },
      400,
    )
  }

  const body = parsed.data
  const run = await findLifecycleRunById(body.runId)
  if (
    !run ||
    run.principalId !== principal.principalId ||
    run.executionMode !== "local" ||
    run.runGroupId !== null
  ) {
    return c.json({ error: { code: "NOT_FOUND", message: "lifecycle run not found" } }, 404)
  }

  const resolvedBinding = await findPrincipalRepoBindingById(run.repoBindingId)
  if (!resolvedBinding) {
    return c.json({ error: { code: "NOT_FOUND", message: "repo binding not found" } }, 404)
  }

  const governance = await evaluateLifecycleGovernance(
    principal,
    resolvedBinding.canonicalRepoNamespace,
    {
      environmentName: run.environmentName,
      destinationClass: body.destinationClass,
      dispatchMode: body.dispatchMode,
    },
  )

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
      metadata: { ...body.metadata, selectedOutputNames: body.selectedOutputNames },
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

    return c.json(
      {
        data: {
          id: blockedItem.id,
          state: blockedItem.state,
          onCompletionUrl: null,
        },
      },
      201,
    )
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
    metadata: { ...body.metadata, selectedOutputNames: body.selectedOutputNames },
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

  return c.json(
    {
      data: {
        id: item.id,
        state: item.state,
        onCompletionUrl: buildPublicUrl(c.req.url, `/api/lifecycle/completions/${callbackToken}`),
      },
    },
    201,
  )
})

lifecycleRoute.post("/dispatch", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }
  const parsed = dispatchRequestSchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: parsed.error.errors[0]?.message ?? "invalid request",
        },
      },
      400,
    )
  }

  const body = parsed.data
  const run = await findLifecycleRunById(body.runId)
  if (
    !run ||
    run.principalId !== principal.principalId ||
    run.executionMode !== "local" ||
    run.runGroupId !== null
  ) {
    return c.json({ error: { code: "NOT_FOUND", message: "lifecycle run not found" } }, 404)
  }

  const item = await findLifecycleItemById(body.itemId)
  if (!item || item.runId !== run.id) {
    return c.json({ error: { code: "NOT_FOUND", message: "lifecycle item not found" } }, 404)
  }

  const binding = await findPrincipalRepoBindingById(run.repoBindingId)
  if (!binding || binding.principalId !== principal.principalId) {
    return c.json({ error: { code: "NOT_FOUND", message: "repo binding not found" } }, 404)
  }
  if (run.status !== "running" || item.state !== "pending") {
    return c.json(
      {
        error: {
          code: "CONFLICT",
          message: "lifecycle dispatch requires a running run and pending item",
        },
      },
      409,
    )
  }

  const selectedOutputNames = lifecycleItemSelectedOutputNames(item)
  if (!selectedOutputNames) {
    return c.json(
      { error: { code: "CONFLICT", message: "lifecycle item has no immutable output policy" } },
      409,
    )
  }
  try {
    body.payload.outputs =
      selectTerraformOutputs({
        outputs: body.payload.outputs,
        selection: { kind: "names", names: selectedOutputNames },
        sensitive: "reject",
      }) ?? {}
  } catch (error) {
    if (error instanceof OutputSelectionError) {
      return c.json(
        { error: { code: error.code, message: error.message, outputNames: error.outputNames } },
        422,
      )
    }
    throw error
  }

  if (
    item.workspacePath !== body.workspacePath ||
    item.phase !== body.phase ||
    item.key !== body.payload.item_key ||
    item.destinationUrl !== lifecycleDispatchDestination(body, binding.canonicalRepoNamespace) ||
    run.environmentName !== body.environmentName ||
    run.environmentName !== body.payload.environment ||
    binding.canonicalRepoNamespace !== body.payload.repo_namespace ||
    body.workspacePath !== body.payload.workspace_path ||
    body.phase !== body.payload.phase
  ) {
    return c.json(
      {
        error: {
          code: "CONFLICT",
          message: "lifecycle dispatch payload does not match the stored item",
        },
      },
      409,
    )
  }

  if (
    !(await isManagedLifecycleDispatchAuthorized(
      principal,
      binding.canonicalRepoNamespace,
      body.dispatch,
    ))
  ) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "lifecycle principal is not authorized to use managed repository credentials",
        },
      },
      403,
    )
  }

  if (!(await claimLifecycleItemForDispatch(item.id))) {
    return c.json(
      { error: { code: "CONFLICT", message: "lifecycle item is no longer pending" } },
      409,
    )
  }

  try {
    await dispatchLifecycleHook(body, binding.canonicalRepoNamespace)

    await updateLifecycleItem(item.id, {
      summary: item.summary ?? `Dispatching ${item.phase} hook`,
    })
    await createLifecycleEvent({
      itemId: item.id,
      eventType: "dispatched",
      payload: {
        kind: body.dispatch.kind,
        workspacePath: body.workspacePath,
        phase: body.phase,
      },
    })

    return c.json({ data: { accepted: true } }, 202)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateLifecycleItem(item.id, {
      state: "failed",
      summary: `Dispatch failed for ${item.key}`,
      reason: message,
      startedAt: item.startedAt ?? new Date(),
      finishedAt: new Date(),
    })
    await createLifecycleEvent({
      itemId: item.id,
      eventType: "dispatch_failed",
      payload: {
        kind: body.dispatch.kind,
        workspacePath: body.workspacePath,
        phase: body.phase,
        reason: message,
      },
    })
    await updateLifecycleRun(run.id, {
      status: "failed",
      finishedAt: new Date(),
    })

    return c.json({ error: { code: "LIFECYCLE_DISPATCH_FAILED", message } }, 502)
  }
})

lifecycleRoute.get("/items/:itemId", async (c) => {
  const principal = c.get("principalAuth")
  const item = await findLifecycleItemForPrincipal(c.req.param("itemId"), principal.principalId)
  if (!item) {
    return c.json({ error: { code: "NOT_FOUND", message: "lifecycle item not found" } }, 404)
  }

  const events = await listLifecycleEventsForItems([item.id])

  return c.json({
    data: serializeLifecycleItem(item, events),
  })
})

lifecycleRoute.get("/state", async (c) => {
  const principal = c.get("principalAuth")
  const canonicalRepoNamespace = c.req.query("canonicalRepoNamespace")
  const localRepoFingerprint = c.req.query("localRepoFingerprint")
  const environmentName = c.req.query("environmentName")
  if (!canonicalRepoNamespace || !localRepoFingerprint || !environmentName) {
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "canonicalRepoNamespace, localRepoFingerprint, and environmentName are required",
        },
      },
      400,
    )
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
  const events = await listLifecycleEventsForItems(state?.items.map((item) => item.id) ?? [])

  return c.json({
    data: state ? serializeLifecycleState(state.run, state.items, events) : null,
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
    return c.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: parsed.error.errors[0]?.message ?? "invalid request",
        },
      },
      400,
    )
  }

  const body = parsed.data
  const consumed = await consumeLifecycleCompletionToken(c.req.param("token"))
  if (!consumed) {
    return c.json(
      {
        error: {
          code: "INVALID_TOKEN",
          message: "lifecycle completion token is invalid or expired",
        },
      },
      404,
    )
  }

  const metadata = mergeCallbackMetadata(consumed.item.metadata, body.externalUrl)

  const itemUpdate: Parameters<typeof updateLifecycleItem>[1] = {
    state: body.status,
    metadata,
    startedAt: consumed.item.startedAt ?? new Date(),
    finishedAt: ["succeeded", "degraded", "failed"].includes(body.status) ? new Date() : null,
  }
  if (body.summary !== undefined) {
    itemUpdate.summary = body.summary
  }
  if (body.reason !== undefined) {
    itemUpdate.reason = body.reason
  }

  const item = await updateLifecycleItem(consumed.item.id, itemUpdate)
  await createLifecycleEvent({
    itemId: consumed.item.id,
    eventType: "callback",
    payload: {
      status: body.status,
      summary: body.summary,
      reason: body.reason,
      externalUrl: body.externalUrl,
    },
  })

  let nextOnCompletionUrl: string | null = null
  if (body.status === "running") {
    const nextToken = randomBytes(32).toString("base64url")
    await issueLifecycleCompletionToken({
      token: nextToken,
      itemId: consumed.item.id,
      expiresAt: consumed.token.expiresAt,
    })
    nextOnCompletionUrl = buildPublicUrl(c.req.url, `/api/lifecycle/completions/${nextToken}`)
  }

  if (item && ["succeeded", "degraded", "failed"].includes(item.state)) {
    await dispatchHostedLifecycleVerificationIfReady({
      runId: consumed.run.id,
      workspacePath: consumed.item.workspacePath,
    })

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

    if (consumed.run.runGroupId) {
      const deployment = await findDeploymentByRunGroupAndWorkspacePath(
        consumed.run.runGroupId,
        consumed.item.workspacePath,
      )
      if (deployment) {
        await reconcileHostedDeploymentState({
          deploymentId: deployment.id,
          workspacePath: deployment.workspacePath,
          lifecycleRunId: consumed.run.id,
          runGroupId: consumed.run.runGroupId,
        })
      }
    }
  }

  return c.json({
    data: {
      id: consumed.item.id,
      state: item?.state ?? body.status,
      nextOnCompletionUrl,
    },
  })
})

async function readJsonBody(request: Request): Promise<unknown> {
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
      JSON.stringify({
        error: { code: "INVALID_REQUEST", message: "request body must be valid JSON" },
      }),
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

  const policyContext = await resolveEnvironmentPolicyContext(
    canonicalRepoNamespace,
    values.environmentName,
  )
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
  if (
    principalTierRank(principalTier) <
    principalTierRank(policyContext.policy.minimumPrincipalTier as PrincipalTier)
  ) {
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
): Promise<{
  repoFullName: string | null
  orgId: string | null
  policy: Awaited<ReturnType<typeof findEnvironmentPolicy>>
}> {
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
  if (
    org &&
    ["pro", "team"].includes(org.planTier) &&
    ["active", "trialing"].includes(org.subscriptionStatus)
  ) {
    return "paid_cloud"
  }

  return "free_local"
}

async function isManagedLifecycleDispatchAuthorized(
  principal: PrincipalAuthContext,
  canonicalRepoNamespace: string,
  dispatch: LifecycleDispatchRequest["dispatch"],
): Promise<boolean> {
  const usesManagedCredential =
    dispatch.kind === "github_repository_dispatch" || dispatch.request.auth !== undefined
  if (!usesManagedCredential) {
    return true
  }
  if (!principal.userId) {
    return false
  }

  const sourceRepoFullName = repo_full_name_from_namespace(canonicalRepoNamespace)
  const sourceRepo = sourceRepoFullName ? await findRepoByFullName(sourceRepoFullName) : undefined
  if (!sourceRepo?.orgId) {
    return false
  }

  if (dispatch.kind === "github_repository_dispatch") {
    const target = resolveGitHubDispatchTarget(dispatch, canonicalRepoNamespace)
    const targetRepo = await findRepoByFullName(`${target.owner}/${target.repo}`)
    if (!targetRepo || targetRepo.orgId !== sourceRepo.orgId) {
      return false
    }
  }

  const membership = await findOrgMembership(sourceRepo.orgId, principal.userId)
  return membership?.role === "admin"
}

async function dispatchLifecycleHook(
  body: LifecycleDispatchRequest,
  canonicalRepoNamespace: string,
): Promise<void> {
  switch (body.dispatch.kind) {
    case "github_repository_dispatch":
      await dispatchGitHubRepositoryDispatch(
        body as GitHubRepositoryDispatchRequest,
        canonicalRepoNamespace,
      )
      return
    case "generic":
      await dispatchGenericLifecycleHook(
        body as GenericLifecycleDispatchRequest,
        canonicalRepoNamespace,
      )
      return
  }
}

async function dispatchGitHubRepositoryDispatch(
  body: GitHubRepositoryDispatchRequest,
  canonicalRepoNamespace: string,
): Promise<void> {
  const target = resolveGitHubDispatchTarget(body.dispatch, canonicalRepoNamespace)
  const fullName = `${target.owner}/${target.repo}`
  const repoRecord = await findRepoByFullName(fullName)
  if (!repoRecord?.installationId) {
    throw new Error(`GitHub App installation is not configured for ${fullName}`)
  }

  const octokit = await getInstallationOctokit(repoRecord.installationId)
  await octokit.request("POST /repos/{owner}/{repo}/dispatches", {
    owner: target.owner,
    repo: target.repo,
    event_type: body.dispatch.github.eventType,
    client_payload: {
      yaffle: body.payload,
    },
  })
}

async function dispatchGenericLifecycleHook(
  body: GenericLifecycleDispatchRequest,
  canonicalRepoNamespace: string,
): Promise<void> {
  const request = body.dispatch.request
  const destination = await resolvePublicLifecycleDestination(request.url)
  const payloadBytes = Buffer.from(JSON.stringify(body.payload))
  const headers = new Headers({
    "content-type": "application/json",
  })

  if (request.auth) {
    const secret = await resolveLifecycleConnectionSecret(
      canonicalRepoNamespace,
      body.environmentName,
      body.workspacePath,
      request.auth.connection,
    )
    applyLifecycleConnectionAuth(headers, request.auth.scheme, secret, payloadBytes, body.itemId)
  }

  const status = await postPublicLifecycleWebhook({
    url: request.url,
    headers,
    body: payloadBytes,
    destination,
  })

  if (status < 200 || status >= 300) {
    throw new Error(`Lifecycle webhook returned ${status}`)
  }
}

function lifecycleItemSelectedOutputNames(item: LifecycleItem): string[] | null {
  if (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) {
    return null
  }
  const names = (item.metadata as Record<string, unknown>).selectedOutputNames
  return Array.isArray(names) && names.every((name): name is string => typeof name === "string")
    ? names
    : null
}

async function resolveLifecycleConnectionSecret(
  canonicalRepoNamespace: string,
  environmentName: string,
  workspacePath: string,
  connectionName: string,
): Promise<string> {
  const repoFullName = repo_full_name_from_namespace(canonicalRepoNamespace)
  if (!repoFullName) {
    throw new Error(`Could not resolve repository from namespace '${canonicalRepoNamespace}'`)
  }

  const repo = await findRepoByFullName(repoFullName)
  if (!repo?.orgId) {
    throw new Error(`Repository '${repoFullName}' is not linked to a Yaffle organization`)
  }

  const matches = (await findConnectionsByName(repo.orgId, connectionName)).filter((connection) => {
    const scope = getConnectionScopeConfig(connection)
    return (
      scopeListAllows(scope.environmentScope, environmentName) &&
      scopeListAllows(scope.workspaceScope, workspacePath)
    )
  })

  if (matches.length === 0) {
    throw new Error(
      `No connection named '${connectionName}' matches ${environmentName} / ${workspacePath}`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple connections named '${connectionName}' match ${environmentName} / ${workspacePath}`,
    )
  }

  const connection = matches[0]
  if (connection.credentialProviderType !== "envvar" || !connection.secretPath) {
    throw new Error(
      `Connection '${connection.name}' must be an envvar-backed connection for lifecycle auth`,
    )
  }

  const org = await findOrgById(connection.orgId)
  if (!org?.iamRoleArn) {
    throw new Error(
      `Organization for connection '${connection.name}' is missing broker role configuration`,
    )
  }

  const brokerCredentials = await assumeOrgBrokerRole(connection.orgId, org.iamRoleArn)
  const secret = (await getConnectionSecret(connection.secretPath, {
    credentials: brokerCredentials,
  })) as {
    envVars?: Array<{ key?: string; value?: string }>
  }
  const envVars = (secret.envVars ?? []).filter(
    (entry): entry is { key: string; value: string } =>
      typeof entry.key === "string" && entry.key.length > 0 && typeof entry.value === "string",
  )

  if (envVars.length !== 1) {
    throw new Error(
      `Connection '${connection.name}' must contain exactly one env var secret for lifecycle auth`,
    )
  }

  return envVars[0].value
}

function applyLifecycleConnectionAuth(
  headers: Headers,
  scheme: "bearer" | "hmac_sha256",
  secret: string,
  body: Buffer,
  itemId: string,
): void {
  if (scheme === "bearer") {
    headers.set("authorization", `Bearer ${secret}`)
    return
  }

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const deliveryId = randomUUID()
  const signature = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(deliveryId)
    .update(".")
    .update(itemId)
    .update(".")
    .update(body)
    .digest("hex")
  headers.set("X-Yaffle-Delivery", deliveryId)
  headers.set("X-Yaffle-Item", itemId)
  headers.set("X-Yaffle-Timestamp", timestamp)
  headers.set("X-Yaffle-Signature", `sha256=${signature}`)
}

function lifecycleDispatchDestination(
  body: LifecycleDispatchRequest,
  canonicalRepoNamespace: string,
): string {
  if (body.dispatch.kind === "generic") {
    return body.dispatch.request.url
  }
  const target = resolveGitHubDispatchTarget(body.dispatch, canonicalRepoNamespace)
  return `https://api.github.com/repos/${target.owner}/${target.repo}/dispatches`
}

function resolveGitHubDispatchTarget(
  dispatch: z.infer<typeof githubRepositoryDispatchSchema>,
  canonicalRepoNamespace: string,
): {
  owner: string
  repo: string
} {
  const explicitOwner = dispatch.github.owner?.trim()
  const explicitRepo = dispatch.github.repo?.trim()
  if (explicitOwner && explicitRepo) {
    return {
      owner: explicitOwner,
      repo: explicitRepo,
    }
  }
  if (explicitOwner || explicitRepo) {
    throw new Error("GitHub repository_dispatch hooks must set both owner and repo together")
  }

  const repoFullName = repo_full_name_from_namespace(canonicalRepoNamespace)
  if (!repoFullName) {
    throw new Error(`Could not resolve repository from namespace '${canonicalRepoNamespace}'`)
  }
  const [owner, repo] = repoFullName.split("/")
  if (!owner || !repo) {
    throw new Error(`Could not resolve repository owner/name from '${repoFullName}'`)
  }

  return { owner, repo }
}

function serializeLifecycleState(
  run: LifecycleRun,
  items: LifecycleItem[],
  events: LifecycleEvent[],
): {
  run: {
    id: string
    status: string
    executionMode: string
    startedAt: string
    finishedAt: string | null
  }
  items: ReturnType<typeof serializeLifecycleItem>[]
} {
  return {
    run: {
      id: run.id,
      status: run.status,
      executionMode: run.executionMode,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    items: items.map((item) =>
      serializeLifecycleItem(
        item,
        events.filter((event) => event.itemId === item.id),
      ),
    ),
  }
}

function serializeLifecycleItem(
  item: LifecycleItem,
  events: LifecycleEvent[],
): {
  id: string
  runId: string
  workspacePath: string
  key: string
  phase: string
  state: string
  failurePolicy: string
  scopes: string[]
  summary: string | null
  reason: string | null
  metadata: Record<string, unknown>
  startedAt: string | null
  finishedAt: string | null
  events: Array<{
    id: string
    eventType: string
    payload: Record<string, unknown>
    createdAt: string
  }>
} {
  return {
    id: item.id,
    runId: item.runId,
    workspacePath: item.workspacePath,
    key: item.key,
    phase: item.phase,
    state: item.state,
    failurePolicy: item.failurePolicy,
    scopes: item.scopes,
    summary: item.summary ?? null,
    reason: item.reason ?? null,
    metadata: publicLifecycleMetadata(item.metadata),
    startedAt: item.startedAt?.toISOString() ?? null,
    finishedAt: item.finishedAt?.toISOString() ?? null,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      payload: publicLifecycleEventPayload(event),
      createdAt: event.createdAt.toISOString(),
    })),
  }
}

function publicLifecycleMetadata(metadata: unknown): Record<string, unknown> {
  const value = recordFromJson(metadata)
  const { hostedDispatch, hostedPayload, callbackTtlMinutes, ...publicMetadata } = value
  void hostedDispatch
  void hostedPayload
  void callbackTtlMinutes
  return publicMetadata
}

function publicLifecycleEventPayload(event: LifecycleEvent): Record<string, unknown> {
  const payload = recordFromJson(event.payload)
  if (event.eventType !== "callback") {
    return payload
  }
  const { metadata, ...publicPayload } = payload
  void metadata
  return publicPayload
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
