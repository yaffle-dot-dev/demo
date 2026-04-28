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
  buildHostedModuleVersion,
  generateAnonymousSessionToken,
  generateExecutionToken,
} from "../lib/principal-tokens.ts"

type PrincipalVariables = {
  principalAuth: PrincipalAuthContext
}

const LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR = "YAFFLE_LOCAL_FIRST_FEATURE_TOKEN"

const ANONYMOUS_SESSION_RATE_LIMIT = {
  bucket: "anonymous-session-bootstrap",
  limit: 20,
  windowMs: 60_000,
} as const

const LOCAL_FIRST_BODY_MAX_BYTES = 128 * 1024

const executionTokenSchema = z.object({
  canonicalRepoNamespace: z.string().min(1),
  localRepoFingerprint: z.string().min(1),
  environmentName: z.string().min(1),
  consumerWorkspacePath: z.string().min(1),
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
  const expectedToken = process.env[LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR]?.trim()
  if (!expectedToken) {
    return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404)
  }

  const providedToken = c.req.header("feature-token")?.trim() ?? ""
  if (!featureTokenMatches(expectedToken, providedToken)) {
    return c.json(
      { error: { code: "INVALID_FEATURE_TOKEN", message: "invalid feature token" } },
      403,
    )
  }

  return next()
}

localFirstRoute.use("/sessions/anonymous", enforceFeatureToken)
localFirstRoute.use("/execution-tokens", enforceFeatureToken)
localFirstRoute.use("/output-modules", enforceFeatureToken)

localFirstRoute.post("/sessions/anonymous", async (c) => {
  const rateLimitResponse = enforceRateLimit(c, ANONYMOUS_SESSION_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

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

  return c.json({
    data: {
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
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }

  const parseResult = executionTokenSchema.safeParse(requestBody)
  if (!parseResult.success) {
    return c.json({ error: { code: "INVALID_REQUEST", message: parseResult.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const body = parseResult.data
  const binding = await ensurePrincipalRepoBinding({
    principalId: principal.principalId,
    canonicalRepoNamespace: body.canonicalRepoNamespace,
    localRepoFingerprint: body.localRepoFingerprint,
  })
  const token = await generateExecutionToken({
    principalId: principal.principalId,
    repoBindingId: binding.id,
    canonicalRepoNamespace: body.canonicalRepoNamespace,
    environmentName: body.environmentName,
    consumerWorkspacePath: body.consumerWorkspacePath,
  })

  return c.json({
    data: {
      token,
      repoBindingId: binding.id,
      expiresAt: new Date(
        Date.now() + DEFAULT_EXECUTION_TOKEN_TTL_MINUTES * 60 * 1000,
      ).toISOString(),
    },
  }, 201)
})

localFirstRoute.put("/output-modules", async (c) => {
  const principal = c.get("principalAuth")
  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }

  const parseResult = publishOutputModuleSchema.safeParse(requestBody)
  if (!parseResult.success) {
    return c.json({ error: { code: "INVALID_REQUEST", message: parseResult.error.errors[0]?.message ?? "invalid request" } }, 400)
  }

  const body = parseResult.data
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

async function readJsonBody(request: Request): Promise<unknown | Response> {
  try {
    const body = await readRequestBodyText(request, LOCAL_FIRST_BODY_MAX_BYTES)
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
        error: {
          code: "INVALID_REQUEST",
          message: "request body must be valid JSON",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }
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
