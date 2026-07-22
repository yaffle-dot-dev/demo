import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { Hono } from "hono"
import { z } from "zod"

import { auth } from "../lib/better-auth.ts"
import {
  createCloudCliAuthorizationCode,
  takeCloudCliAuthorizationCode,
} from "../db/queries/cloud-cli-authorization-codes.ts"
import {
  findAnonymousSessionById,
  ensureAccountPrincipal,
  migrateAnonymousPrincipalToAccount,
} from "../db/queries/principals.ts"
import { findUserById } from "../db/queries/users.ts"
import {
  DEFAULT_ACCOUNT_PRINCIPAL_TOKEN_TTL_DAYS,
  generateAccountPrincipalToken,
  verifyAccountPrincipalToken,
  verifyAnonymousSessionToken,
} from "../lib/principal-tokens.ts"
import {
  enforceRateLimit,
  readRequestBodyText,
  RequestBodyTooLargeError,
} from "../lib/request-protection.ts"
import { buildPublicUrl } from "../lib/public-origin.ts"
import { logger as log } from "../lib/telemetry.ts"

export const cloudCliRoute = new Hono()

const CLOUD_CLI_AUTHORIZE_RATE_LIMIT = {
  bucket: "cloud-cli-authorize",
  limit: 20,
  windowMs: 60_000,
} as const

const CLOUD_CLI_TOKEN_RATE_LIMIT = {
  bucket: "cloud-cli-token",
  limit: 20,
  windowMs: 60_000,
} as const

const CLOUD_CLI_TOKEN_MAX_BYTES = 16 * 1024
const CLOUD_CLI_AUTHORIZE_REQUEST_MAX_BYTES = 8 * 1024
const CLOUD_CLI_AUTHORIZE_REQUEST_TTL_MS = 5 * 60 * 1000
const pkceValueSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/)

const callbackPortSchema = z.number().int().min(1024).max(65535)

const authorizeRequestSchema = z
  .object({
    client_id: z.literal("yaffle-cli"),
    redirect_port: callbackPortSchema,
    response_type: z.literal("code"),
    code_challenge: pkceValueSchema,
    code_challenge_method: z.literal("S256"),
    state: z.string().optional(),
  })
  .strict()

const legacyAuthorizeQuerySchema = z.object({
  client_id: z.literal("yaffle-cli"),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  code_challenge: pkceValueSchema,
  code_challenge_method: z.literal("S256"),
  state: z.string().optional(),
})

const signedAuthorizeRequestSchema = authorizeRequestSchema.extend({
  exp: z.number().int(),
})

const browserAuthorizeQuerySchema = z.object({
  request: z.string().min(1),
})

const tokenBodySchema = z
  .object({
    grant_type: z.literal("authorization_code"),
    code: z.string(),
    code_verifier: pkceValueSchema,
    redirect_port: callbackPortSchema,
    client_id: z.literal("yaffle-cli"),
    current_principal_token: z.string().min(1).nullish(),
  })
  .strict()

type JsonBody = null | boolean | number | string | JsonBody[] | { [key: string]: JsonBody }
type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>
type LegacyAuthorizeQuery = z.infer<typeof legacyAuthorizeQuerySchema>

function renderLoginRedirectPage(currentUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Redirecting to GitHub...</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #888; }
  </style>
</head>
<body>
  <p>Redirecting to GitHub...</p>
  <script>
    (async () => {
      try {
        const res = await fetch('/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'github',
            callbackURL: ${JSON.stringify(currentUrl)}
          })
        });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          document.body.innerHTML = '<p style="color:#f85149">Login failed: ' + (data.message || 'Unknown error') + '</p>';
        }
      } catch (err) {
        document.body.innerHTML = '<p style="color:#f85149">Login failed: ' + err.message + '</p>';
      }
    })();
  </script>
</body>
</html>`
}

function renderAuthorizeSuccessPage(finalRedirect: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Yaffle - Cloud Login</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #09090b;
      --panel: #18181b;
      --border: #3f3f46;
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #36a9fa;
      --ok: #22c55e;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at top, #111827, var(--bg) 45%);
      color: var(--text);
      font-family: "JetBrains Mono", ui-monospace, monospace;
    }
    .panel {
      width: min(32rem, calc(100vw - 2rem));
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2rem;
      text-align: center;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 999px;
      background: rgba(34, 197, 94, 0.15);
      color: var(--ok);
      margin-bottom: 1rem;
      font-size: 1.5rem;
    }
    h1 { margin: 0 0 0.5rem; font-size: 1rem; }
    p { margin: 0; color: var(--muted); font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="panel">
    <div class="badge">✓</div>
    <h1>Yaffle Cloud login approved</h1>
    <p>Completing authentication in your CLI...</p>
  </div>
  <script>
    setTimeout(() => {
      window.location.href = ${JSON.stringify(finalRedirect)};
    }, 900);
  </script>
</body>
</html>`
}

function callbackRedirectUri(redirectPort: number): string {
  return `http://localhost:${redirectPort}/callback`
}

function validateLoopbackRedirectUri(redirectUri: string): Response | null {
  let redirectUrl: URL
  try {
    redirectUrl = new URL(redirectUri)
  } catch {
    return Response.json(
      { error: "invalid_request", error_description: "redirect_uri must be a valid URL" },
      { status: 400 },
    )
  }

  if (redirectUrl.protocol !== "http:") {
    return Response.json(
      { error: "invalid_request", error_description: "redirect_uri must use http" },
      { status: 400 },
    )
  }

  if (redirectUrl.hostname !== "localhost") {
    return Response.json(
      { error: "invalid_request", error_description: "redirect_uri must be localhost" },
      { status: 400 },
    )
  }

  const port = Number.parseInt(redirectUrl.port || "80", 10)
  if (port < 1024 || port > 65535) {
    return Response.json(
      { error: "invalid_request", error_description: "redirect_uri port must be 1024-65535" },
      { status: 400 },
    )
  }

  if (redirectUrl.pathname !== "/callback") {
    return Response.json(
      { error: "invalid_request", error_description: "redirect_uri path must be /callback" },
      { status: 400 },
    )
  }

  return null
}

function redirectPortFromLegacyAuthorizeQuery(query: LegacyAuthorizeQuery): number | Response {
  const redirectError = validateLoopbackRedirectUri(query.redirect_uri)
  if (redirectError) {
    return redirectError
  }

  return Number.parseInt(new URL(query.redirect_uri).port, 10)
}

function authorizeSigningSecret(): Buffer | null {
  const authSecret = process.env.BETTER_AUTH_SECRET?.trim()
  if (!authSecret) return null

  return createHmac("sha256", authSecret).update("yaffle-cloud-cli-authorize-v1").digest()
}

function signAuthorizeRequest(input: AuthorizeRequest): string | null {
  const secret = authorizeSigningSecret()
  if (!secret) return null

  const payload = Buffer.from(
    JSON.stringify({
      ...input,
      exp: Date.now() + CLOUD_CLI_AUTHORIZE_REQUEST_TTL_MS,
    }),
  ).toString("base64url")
  const signature = createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

function invalidAuthorizeRequestResponse(description = "Invalid CLI authorize request"): Response {
  return Response.json(
    { error: "invalid_request", error_description: description },
    { status: 400 },
  )
}

function verifyAuthorizeRequest(token: string): AuthorizeRequest | Response {
  const secret = authorizeSigningSecret()
  if (!secret) {
    return Response.json(
      { error: "server_error", error_description: "CLI authorize signing is not configured" },
      { status: 500 },
    )
  }

  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return invalidAuthorizeRequestResponse()
  }

  const [payload, signature] = parts
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url")
  const provided = Buffer.from(signature)
  const expected = Buffer.from(expectedSignature)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return invalidAuthorizeRequestResponse()
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return invalidAuthorizeRequestResponse()
  }

  const parsed = signedAuthorizeRequestSchema.safeParse(decoded)
  if (!parsed.success || parsed.data.exp <= Date.now()) {
    return invalidAuthorizeRequestResponse("Expired CLI authorize request")
  }

  return {
    client_id: parsed.data.client_id,
    redirect_port: parsed.data.redirect_port,
    response_type: parsed.data.response_type,
    code_challenge: parsed.data.code_challenge,
    code_challenge_method: parsed.data.code_challenge_method,
    state: parsed.data.state,
  }
}

function browserAuthorizePath(input: AuthorizeRequest): string | null {
  const token = signAuthorizeRequest(input)
  if (!token) return null

  const params = new URLSearchParams({ request: token })
  return `/api/cloud/cli/authorize?${params.toString()}`
}

function resolveAuthorizeRequest(requestUrl: string): AuthorizeRequest | Response {
  const queryParams = Object.fromEntries(new URL(requestUrl).searchParams)
  const browserQuery = browserAuthorizeQuerySchema.safeParse(queryParams)
  if (browserQuery.success) {
    return verifyAuthorizeRequest(browserQuery.data.request)
  }

  const legacyQuery = legacyAuthorizeQuerySchema.safeParse(queryParams)
  if (!legacyQuery.success) {
    return Response.json(
      {
        error: "invalid_request",
        error_description: legacyQuery.error.errors[0]?.message ?? "Invalid parameters",
      },
      { status: 400 },
    )
  }

  const redirectPort = redirectPortFromLegacyAuthorizeQuery(legacyQuery.data)
  if (redirectPort instanceof Response) {
    return redirectPort
  }

  return {
    client_id: legacyQuery.data.client_id,
    redirect_port: redirectPort,
    response_type: legacyQuery.data.response_type,
    code_challenge: legacyQuery.data.code_challenge,
    code_challenge_method: legacyQuery.data.code_challenge_method,
    state: legacyQuery.data.state,
  }
}

cloudCliRoute.post("/cli/authorize-requests", async (c) => {
  const rateLimitResponse = enforceRateLimit(c, CLOUD_CLI_AUTHORIZE_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  const requestBody = await readJsonBody(c.req.raw, CLOUD_CLI_AUTHORIZE_REQUEST_MAX_BYTES)
  if (requestBody instanceof Response) {
    return requestBody
  }

  const parsed = authorizeRequestSchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_request",
        error_description: parsed.error.errors[0]?.message ?? "Invalid parameters",
      },
      400,
    )
  }

  const path = browserAuthorizePath(parsed.data)
  if (!path) {
    return c.json(
      { error: "server_error", error_description: "CLI authorize signing is not configured" },
      500,
    )
  }

  return c.json({
    data: {
      authorizeUrl: buildPublicUrl(c.req.url, path),
      expiresAt: new Date(Date.now() + CLOUD_CLI_AUTHORIZE_REQUEST_TTL_MS).toISOString(),
    },
  })
})

cloudCliRoute.get("/cli/authorize", async (c) => {
  const rateLimitResponse = enforceRateLimit(c, CLOUD_CLI_AUTHORIZE_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  const resolved = resolveAuthorizeRequest(c.req.url)
  if (resolved instanceof Response) {
    return resolved
  }

  const query = resolved
  const redirectUri = callbackRedirectUri(query.redirect_port)

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  if (!session?.user) {
    const callbackPath = browserAuthorizePath(query)
    if (!callbackPath) {
      return c.json(
        { error: "server_error", error_description: "CLI authorize signing is not configured" },
        500,
      )
    }
    const currentUrl = buildPublicUrl(c.req.url, callbackPath)
    return c.html(renderLoginRedirectPage(currentUrl))
  }

  const code = randomBytes(32).toString("base64url")
  await createCloudCliAuthorizationCode({
    code,
    userId: session.user.id,
    codeChallenge: query.code_challenge,
    codeChallengeMethod: query.code_challenge_method,
    redirectUri,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  })

  log.info("Cloud CLI authorization code issued", {
    userId: session.user.id,
    redirectPort: query.redirect_port,
  })

  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set("code", code)
  if (query.state) {
    callbackUrl.searchParams.set("state", query.state)
  }

  return c.html(renderAuthorizeSuccessPage(callbackUrl.toString()))
})

cloudCliRoute.post("/cli/token", async (c) => {
  const rateLimitResponse = enforceRateLimit(c, CLOUD_CLI_TOKEN_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  const requestBody = await readJsonBody(c.req.raw)
  if (requestBody instanceof Response) {
    return requestBody
  }

  const parsed = tokenBodySchema.safeParse(requestBody)
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_request",
        error_description: parsed.error.errors[0]?.message ?? "invalid request",
      },
      400,
    )
  }

  const body = parsed.data
  const redirectUri = callbackRedirectUri(body.redirect_port)
  const verifierHash = createHash("sha256").update(body.code_verifier).digest("base64url")
  const pending = await takeCloudCliAuthorizationCode({
    code: body.code,
    redirectUri,
    codeChallenge: verifierHash,
    now: new Date(),
  })
  if (!pending) {
    return c.json({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400)
  }

  const authUser = await findUserById(pending.userId)
  if (!authUser) {
    return c.json(
      { error: "invalid_grant", error_description: "Authenticated user was not found" },
      400,
    )
  }

  const accountPrincipal = await ensureAccountPrincipal({
    userId: authUser.id,
  })

  let convertedFromAnonymous = false
  if (body.current_principal_token) {
    const anonymousPayload = await verifyAnonymousSessionToken(body.current_principal_token)
    if (anonymousPayload) {
      const record = await findAnonymousSessionById(anonymousPayload.session_id)
      if (!record || record.principal.id !== anonymousPayload.principal_id) {
        return c.json(
          { error: "invalid_grant", error_description: "Current anonymous principal is invalid" },
          400,
        )
      }
      if (record.principal.status === "active" && record.session.status === "active") {
        await migrateAnonymousPrincipalToAccount({
          anonymousPrincipalId: record.principal.id,
          accountPrincipalId: accountPrincipal.id,
        })
        convertedFromAnonymous = true
      }
    } else {
      const currentAccount = await verifyAccountPrincipalToken(body.current_principal_token)
      if (!currentAccount || currentAccount.user_id !== authUser.id) {
        return c.json(
          { error: "invalid_grant", error_description: "Current principal token is invalid" },
          400,
        )
      }
    }
  }

  const token = await generateAccountPrincipalToken({
    principalId: accountPrincipal.id,
    userId: authUser.id,
  })
  const issuedAt = new Date()
  const expiresAt = new Date(
    issuedAt.getTime() + DEFAULT_ACCOUNT_PRINCIPAL_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  )

  log.info("Cloud CLI account principal issued", {
    userId: authUser.id,
    principalId: accountPrincipal.id,
    convertedFromAnonymous,
  })

  return c.json({
    data: {
      principalId: accountPrincipal.id,
      principalType: "account",
      token,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      userId: authUser.id,
      userEmail: authUser.email,
      userName: authUser.name,
      convertedFromAnonymous,
    },
  })
})

async function readJsonBody(
  request: Request,
  maxBytes = CLOUD_CLI_TOKEN_MAX_BYTES,
): Promise<JsonBody | Response> {
  try {
    const body = await readRequestBodyText(request, maxBytes)
    return body ? (JSON.parse(body) as JsonBody) : {}
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
