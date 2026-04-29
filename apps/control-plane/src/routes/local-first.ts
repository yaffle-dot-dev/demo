import { Hono, type MiddlewareHandler } from "hono"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"

import {
  createAnonymousSession,
  createPrincipal,
  ensurePrincipalRepoBinding,
  publishHostedOutputModule,
} from "../db/queries/principals.ts"
import { principalAuth, type PrincipalAuthContext } from "../middleware/principal-auth.ts"
import { enforceRateLimit, readRequestBodyText, RequestBodyTooLargeError } from "../lib/request-protection.ts"
import {
  DEFAULT_ANONYMOUS_SESSION_TTL_DAYS,
  DEFAULT_EXECUTION_TOKEN_TTL_MINUTES,
  DEFAULT_SHELL_SESSION_EXECUTION_TOKEN_TTL_MINUTES,
  buildHostedModuleVersion,
  generateAnonymousSessionToken,
  generateExecutionToken,
} from "../lib/principal-tokens.ts"
import {
  getLocalFirstOperationsCounter,
  getLocalFirstPayloadBytesHistogram,
} from "../lib/telemetry.ts"

type PrincipalVariables = {
  principalAuth: PrincipalAuthContext
}

type LocalFirstOperation =
  | "anonymous_session_bootstrap"
  | "execution_token_mint"
  | "output_module_publish"

const LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR = "YAFFLE_LOCAL_FIRST_FEATURE_TOKEN"

const ANONYMOUS_SESSION_RATE_LIMIT = {
  bucket: "anonymous-session-bootstrap",
  limit: 20,
  windowMs: 60_000,
} as const

const EXECUTION_TOKEN_RATE_LIMIT = {
  bucket: "local-first-execution-token",
  limit: 120,
  windowMs: 60_000,
} as const

const OUTPUT_MODULE_PUBLISH_RATE_LIMIT = {
  bucket: "local-first-output-module-publish",
  limit: 120,
  windowMs: 60_000,
} as const

const LOCAL_FIRST_BODY_MAX_BYTES = 128 * 1024

const executionTokenSchema = z.object({
  canonicalRepoNamespace: z.string().min(1),
  localRepoFingerprint: z.string().min(1),
  environmentName: z.string().min(1),
  consumerWorkspacePath: z.string().min(1),
  sessionKind: z.enum(["workspace_init", "shell_session"]).default("workspace_init"),
})

const publishOutputModuleSchema = z.object({
  canonicalRepoNamespace: z.string().min(1),
  localRepoFingerprint: z.string().min(1),
  environmentName: z.string().min(1),
  workspacePath: z.string().min(1),
  stateFingerprint: z.string().min(1),
  outputs: z.record(z.unknown()),
})

export const localFirstRoute = new Hono<{ Variables: PrincipalVariables }>()

const enforceFeatureToken: MiddlewareHandler = async (c, next) => {
  const operation = localFirstOperationFromPath(c.req.path)
  const expectedToken = process.env[LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR]?.trim()
  if (!expectedToken) {
    recordLocalFirstOperation(operation, "feature_disabled")
    return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404)
  }

  const providedToken = c.req.header("feature-token")?.trim() ?? ""
  if (!featureTokenMatches(expectedToken, providedToken)) {
    recordLocalFirstOperation(operation, "invalid_feature_token")
    return c.json(
      { error: { code: "INVALID_FEATURE_TOKEN", message: "invalid feature token" } },
      403,
    )
  }

  return next()
}

function enforceRouteRateLimit(options: {
  bucket: string
  limit: number
  windowMs: number
}): MiddlewareHandler {
  return async (c, next) => {
    const rateLimitResponse = enforceRateLimit(c, options)
    if (rateLimitResponse) {
      recordLocalFirstOperation(localFirstOperationFromPath(c.req.path), "rate_limited")
      return rateLimitResponse
    }

    return next()
  }
}

localFirstRoute.use("/sessions/anonymous", enforceFeatureToken)
localFirstRoute.use("/execution-tokens", enforceFeatureToken)
localFirstRoute.use("/output-modules", enforceFeatureToken)
localFirstRoute.use("/sessions/anonymous", enforceRouteRateLimit(ANONYMOUS_SESSION_RATE_LIMIT))
localFirstRoute.use("/execution-tokens", enforceRouteRateLimit(EXECUTION_TOKEN_RATE_LIMIT))
localFirstRoute.use("/output-modules", enforceRouteRateLimit(OUTPUT_MODULE_PUBLISH_RATE_LIMIT))

localFirstRoute.post("/sessions/anonymous", async (c) => {
  const principal = await createPrincipal({
    type: "anonymous_session",
  })
  const expiresAt = new Date(Date.now() + DEFAULT_ANONYMOUS_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  const session = await createAnonymousSession({
    principalId: principal.id,
    expiresAt,
  })
  const token = await generateAnonymousSessionToken({
    principalId: principal.id,
    sessionId: session.id,
  })
  recordLocalFirstOperation("anonymous_session_bootstrap", "success")

  return c.json({
    data: {
      principalType: "anonymous_session",
      principalId: principal.id,
      sessionId: session.id,
      token,
      issuedAt: session.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
  }, 201)
})

localFirstRoute.use("/execution-tokens", principalAuth())
localFirstRoute.use("/output-modules", principalAuth())

localFirstRoute.post("/execution-tokens", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw, "execution_token_mint")
  if (requestBody instanceof Response) {
    return requestBody
  }

  const parseResult = executionTokenSchema.safeParse(requestBody)
  if (!parseResult.success) {
    recordLocalFirstOperation("execution_token_mint", "invalid_request")
    return c.json({ error: { code: "INVALID_REQUEST", message: parseResult.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const body = parseResult.data
  const ttlMinutes = body.sessionKind === "shell_session"
    ? DEFAULT_SHELL_SESSION_EXECUTION_TOKEN_TTL_MINUTES
    : DEFAULT_EXECUTION_TOKEN_TTL_MINUTES
  const binding = await ensurePrincipalRepoBinding({
    principalId: principal.principalId,
    canonicalRepoNamespace: body.canonicalRepoNamespace,
    localRepoFingerprint: body.localRepoFingerprint,
  })
  const token = await generateExecutionToken({
    principalId: principal.principalId,
    sessionId: principal.sessionId,
    repoBindingId: binding.id,
    canonicalRepoNamespace: body.canonicalRepoNamespace,
    environmentName: body.environmentName,
    consumerWorkspacePath: body.consumerWorkspacePath,
    ttlMinutes,
  })
  recordLocalFirstOperation("execution_token_mint", "success", {
    session_kind: body.sessionKind,
  })

  return c.json({
    data: {
      token,
      repoBindingId: binding.id,
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
    },
  }, 201)
})

localFirstRoute.put("/output-modules", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw, "output_module_publish")
  if (requestBody instanceof Response) {
    return requestBody
  }

  const parseResult = publishOutputModuleSchema.safeParse(requestBody)
  if (!parseResult.success) {
    recordLocalFirstOperation("output_module_publish", "invalid_request")
    return c.json({ error: { code: "INVALID_REQUEST", message: parseResult.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const body = parseResult.data
  const outputBytes = Buffer.byteLength(JSON.stringify(body.outputs), "utf8")
  const binding = await ensurePrincipalRepoBinding({
    principalId: principal.principalId,
    canonicalRepoNamespace: body.canonicalRepoNamespace,
    localRepoFingerprint: body.localRepoFingerprint,
  })
  const published = await publishHostedOutputModule({
    principalId: principal.principalId,
    repoBindingId: binding.id,
    environmentName: body.environmentName,
    workspacePath: body.workspacePath,
    stateFingerprint: body.stateFingerprint,
    outputs: body.outputs,
  })
  getLocalFirstPayloadBytesHistogram().record(outputBytes, {
    operation: "output_module_publish",
  })
  recordLocalFirstOperation("output_module_publish", "success")

  return c.json({
    data: {
      id: published.id,
      repoBindingId: published.repoBindingId,
      workspacePath: published.workspacePath,
      environmentName: published.environmentName,
      versionSerial: published.versionSerial,
      version: buildHostedModuleVersion(published.versionSerial),
      createdAt: published.createdAt.toISOString(),
    },
  }, 201)
})

async function readJsonBody(
  request: Request,
  operation: LocalFirstOperation,
): Promise<unknown | Response> {
  try {
    const body = await readRequestBodyText(request, LOCAL_FIRST_BODY_MAX_BYTES)
    return body ? JSON.parse(body) : {}
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      recordLocalFirstOperation(operation, "request_too_large")
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
    recordLocalFirstOperation(operation, "invalid_json")
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_REQUEST",
          message: "request body must be valid JSON",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }
}

function localFirstOperationFromPath(path: string): LocalFirstOperation {
  if (path.endsWith("/sessions/anonymous")) {
    return "anonymous_session_bootstrap"
  }
  if (path.endsWith("/execution-tokens")) {
    return "execution_token_mint"
  }
  return "output_module_publish"
}

function recordLocalFirstOperation(
  operation: LocalFirstOperation,
  result: string,
  attrs?: Record<string, string | number | boolean>,
): void {
  getLocalFirstOperationsCounter().add(1, {
    operation,
    result,
    ...attrs,
  })
}

function featureTokenMatches(expectedToken: string, providedToken: string): boolean {
  if (!providedToken) {
    return false
  }

  const expected = Buffer.from(expectedToken)
  const provided = Buffer.from(providedToken)
  if (expected.length !== provided.length) {
    return false
  }

  return timingSafeEqual(expected, provided)
}
