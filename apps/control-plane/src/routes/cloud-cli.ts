import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { Hono } from "hono"
import { z } from "zod"

import { auth } from "../lib/better-auth.ts"
import {
  createCloudCliAuthorizationCode,
  takeCloudCliAuthorizationCode,
} from "../db/queries/cloud-cli-authorization-codes.ts"
import { findAnonymousSessionById, ensureAccountPrincipal, migrateAnonymousPrincipalToAccount } from "../db/queries/principals.ts"
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

const LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR = "YAFFLE_LOCAL_FIRST_FEATURE_TOKEN"

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

const authorizeQuerySchema = z.object({
  client_id: z.literal("yaffle-cli"),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().optional(),
  feature_token: z.string().min(1),
})

const tokenBodySchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string(),
  code_verifier: z.string().min(43).max(128),
  redirect_uri: z.string().url(),
  client_id: z.literal("yaffle-cli"),
  current_principal_token: z.string().min(1).nullish(),
})

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

function validateFeatureToken(providedToken: string): Response | null {
  const expectedToken = process.env[LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR]?.trim()
  if (!expectedToken) {
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  const expected = Buffer.from(expectedToken)
  const provided = Buffer.from(providedToken)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_FEATURE_TOKEN",
          message: "invalid feature token",
        },
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  return null
}

cloudCliRoute.get("/cli/authorize", async (c) => {
  const rateLimitResponse = enforceRateLimit(c, CLOUD_CLI_AUTHORIZE_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  const queryParams = Object.fromEntries(new URL(c.req.url).searchParams)
  const parsed = authorizeQuerySchema.safeParse(queryParams)
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_request",
        error_description: parsed.error.errors[0]?.message ?? "Invalid parameters",
      },
      400,
    )
  }

  const query = parsed.data
  const featureTokenError = validateFeatureToken(query.feature_token)
  if (featureTokenError) {
    return featureTokenError
  }

  const redirectUrl = new URL(query.redirect_uri)
  if (redirectUrl.hostname !== "localhost" && redirectUrl.hostname !== "127.0.0.1") {
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri must be localhost" },
      400,
    )
  }

  const port = Number.parseInt(redirectUrl.port || "80", 10)
  if (port < 10000 || port > 10010) {
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri port must be 10000-10010" },
      400,
    )
  }

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })
  if (!session?.user) {
    const currentRequestUrl = new URL(c.req.url)
    const currentUrl = buildPublicUrl(c.req.url, `${currentRequestUrl.pathname}${currentRequestUrl.search}`)
    return c.html(renderLoginRedirectPage(currentUrl))
  }

  const code = randomBytes(32).toString("base64url")
  await createCloudCliAuthorizationCode({
    code,
    userId: session.user.id,
    codeChallenge: query.code_challenge,
    codeChallengeMethod: query.code_challenge_method,
    redirectUri: query.redirect_uri,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  })

  log.info("Cloud CLI authorization code issued", {
    userId: session.user.id,
    redirectUri: query.redirect_uri,
  })

  const callbackUrl = new URL(query.redirect_uri)
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

  const featureTokenError = validateFeatureToken(c.req.header("feature-token")?.trim() ?? "")
  if (featureTokenError) {
    return featureTokenError
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
  const pending = await takeCloudCliAuthorizationCode(body.code)
  if (!pending || pending.expiresAt.getTime() <= Date.now()) {
    return c.json(
      { error: "invalid_grant", error_description: "Invalid or expired code" },
      400,
    )
  }
  if (pending.redirectUri !== body.redirect_uri) {
    return c.json(
      { error: "invalid_grant", error_description: "redirect_uri mismatch" },
      400,
    )
  }

  const verifierHash = createHash("sha256").update(body.code_verifier).digest("base64url")
  if (verifierHash !== pending.codeChallenge) {
    return c.json(
      { error: "invalid_grant", error_description: "PKCE validation failed" },
      400,
    )
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
    } else if (!(await verifyAccountPrincipalToken(body.current_principal_token))) {
      return c.json(
        { error: "invalid_grant", error_description: "Current principal token is invalid" },
        400,
      )
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

async function readJsonBody(request: Request): Promise<unknown | Response> {
  try {
    const body = await readRequestBodyText(request, CLOUD_CLI_TOKEN_MAX_BYTES)
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
