import { Hono } from "hono"
import { z } from "zod"
import { createHash, randomBytes } from "node:crypto"

import { logger as log } from "../../lib/telemetry.ts"
import { auth } from "../../lib/better-auth.ts"
import { createApiToken, generateToken } from "../../db/queries/api-tokens.ts"

/**
 * OAuth endpoints for Terraform CLI login.
 * Implements the authorization code grant with PKCE.
 *
 * Flow:
 * 1. CLI calls GET /tfc/oauth/authorize with code_challenge
 * 2. User authenticates via GitHub (BetterAuth)
 * 3. We redirect back to CLI's localhost callback with auth code
 * 4. CLI calls POST /tfc/oauth/token with code + code_verifier
 * 5. We validate PKCE, create API token, return to CLI
 */
export const oauthCliRoute = new Hono()

// In-memory store for pending authorization codes
// In production, consider Redis for multi-instance deployments
interface PendingAuth {
  userId: string
  codeChallenge: string
  codeChallengeMethod: string
  redirectUri: string
  expiresAt: number
}

const pendingAuths = new Map<string, PendingAuth>()

// Clean up expired auth codes periodically
setInterval(
  () => {
    const now = Date.now()
    for (const [code, pending] of pendingAuths) {
      if (pending.expiresAt < now) {
        pendingAuths.delete(code)
      }
    }
  },
  60 * 1000,
) // Every minute

// Validation schemas
const authorizeQuerySchema = z.object({
  client_id: z.literal("terraform-cli"),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().optional(),
})

const tokenBodySchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string(),
  code_verifier: z.string().min(43).max(128),
  redirect_uri: z.string().url(),
  client_id: z.literal("terraform-cli"),
})

/**
 * GET /tfc/oauth/authorize
 *
 * Authorization endpoint. Validates the request, ensures user is authenticated,
 * then redirects to CLI's localhost callback with an authorization code.
 */
oauthCliRoute.get("/authorize", async (c) => {
  // Parse and validate query parameters
  const queryParams = Object.fromEntries(new URL(c.req.url).searchParams)
  const parseResult = authorizeQuerySchema.safeParse(queryParams)

  if (!parseResult.success) {
    return c.json(
      {
        error: "invalid_request",
        error_description: parseResult.error.errors[0]?.message ?? "Invalid parameters",
      },
      400,
    )
  }

  const query = parseResult.data

  // Validate redirect_uri is a localhost URL with allowed port
  const redirectUrl = new URL(query.redirect_uri)
  if (redirectUrl.hostname !== "localhost" && redirectUrl.hostname !== "127.0.0.1") {
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri must be localhost" },
      400,
    )
  }

  const port = parseInt(redirectUrl.port || "80", 10)
  if (port < 10000 || port > 10010) {
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri port must be 10000-10010" },
      400,
    )
  }

  // Check if user is authenticated via BetterAuth session
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!session?.user) {
    // Not authenticated - auto-redirect to GitHub OAuth
    // BetterAuth requires POST with JSON, so we use a minimal page that auto-submits
    // Ensure we use HTTPS for the callback (Caddy terminates TLS)
    const currentUrl = c.req.url.replace(/^http:/, "https:")
    const html = `<!DOCTYPE html>
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
    return c.html(html)
  }

  // User is authenticated - generate authorization code
  const code = randomBytes(32).toString("base64url")
  const expiresAt = Date.now() + 5 * 60 * 1000 // 5 minutes

  pendingAuths.set(code, {
    userId: session.user.id,
    codeChallenge: query.code_challenge,
    codeChallengeMethod: query.code_challenge_method,
    redirectUri: query.redirect_uri,
    expiresAt,
  })

  log.info("OAuth authorization code issued", {
    userId: session.user.id,
    redirectUri: query.redirect_uri,
  })

  // Build the CLI callback URL
  const callbackUrl = new URL(query.redirect_uri)
  callbackUrl.searchParams.set("code", code)
  if (query.state) {
    callbackUrl.searchParams.set("state", query.state)
  }
  const finalRedirect = callbackUrl.toString()

  // Show a nice success page before redirecting to Terraform's localhost callback
  // Styled to match the Yaffle design system
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Yaffle - Success</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --font-mono: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
      --color-yaffle-400: #36a9fa;
      --color-surface: #09090b;
      --color-surface-raised: #18181b;
      --color-border: #3f3f46;
      --color-text: #fafafa;
      --color-text-muted: #a1a1aa;
      --color-text-dim: #71717a;
      --color-status-ready: #22c55e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-mono);
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      background: var(--color-surface);
      color: var(--color-text);
    }
    .container {
      text-align: center;
      animation: fadeIn 0.3s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .logo {
      font-size: 1.125rem;
      font-weight: 700;
      color: var(--color-yaffle-400);
      margin-bottom: 2rem;
      letter-spacing: -0.025em;
    }
    .card {
      background: var(--color-surface-raised);
      border: 1px solid var(--color-border);
      border-radius: 0.75rem;
      padding: 2rem 3rem;
    }
    .checkmark {
      width: 48px;
      height: 48px;
      margin: 0 auto 1rem;
      border-radius: 50%;
      background: rgba(34, 197, 94, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .checkmark svg {
      width: 24px;
      height: 24px;
      stroke: var(--color-status-ready);
      stroke-width: 2.5;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    h1 {
      font-size: 1rem;
      font-weight: 500;
      margin: 0 0 0.5rem;
    }
    p {
      color: var(--color-text-dim);
      font-size: 0.75rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">yaffle</div>
    <div class="card">
      <div class="checkmark">
        <svg viewBox="0 0 24 24">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <h1>You're all set!</h1>
      <p>Completing authentication...</p>
    </div>
  </div>
  <script>
    setTimeout(() => {
      window.location.href = ${JSON.stringify(finalRedirect)};
    }, 1200);
  </script>
</body>
</html>`

  return c.html(html)
})

/**
 * POST /tfc/oauth/token
 *
 * Token endpoint. Exchanges authorization code for API token.
 * Validates PKCE code_verifier against stored code_challenge.
 */
oauthCliRoute.post("/token", async (c) => {
  // Parse form body
  const contentType = c.req.header("content-type") || ""
  let bodyData: Record<string, string>

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await c.req.parseBody()
    bodyData = Object.fromEntries(
      Object.entries(formData).map(([k, v]) => [k, String(v)]),
    )
  } else if (contentType.includes("application/json")) {
    bodyData = await c.req.json()
  } else {
    return c.json({ error: "invalid_request", error_description: "Invalid content type" }, 400)
  }

  const parseResult = tokenBodySchema.safeParse(bodyData)

  if (!parseResult.success) {
    return c.json(
      {
        error: "invalid_request",
        error_description: parseResult.error.errors[0]?.message ?? "Invalid parameters",
      },
      400,
    )
  }

  const body = parseResult.data

  // Look up pending authorization
  const pending = pendingAuths.get(body.code)
  if (!pending) {
    return c.json({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400)
  }

  // Check expiration
  if (pending.expiresAt < Date.now()) {
    pendingAuths.delete(body.code)
    return c.json({ error: "invalid_grant", error_description: "Code expired" }, 400)
  }

  // Verify redirect_uri matches
  if (pending.redirectUri !== body.redirect_uri) {
    return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400)
  }

  // Verify PKCE - hash code_verifier and compare to stored code_challenge
  const verifierHash = createHash("sha256").update(body.code_verifier).digest("base64url")

  if (verifierHash !== pending.codeChallenge) {
    log.warn("PKCE verification failed", { userId: pending.userId })
    return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400)
  }

  // PKCE verified - delete the code (one-time use)
  pendingAuths.delete(body.code)

  // Generate API token
  const { token, hash } = generateToken()

  // Store in database
  await createApiToken({
    userId: pending.userId,
    tokenHash: hash,
    description: "terraform login",
    // No expiration for CLI tokens by default
    // Users can manage tokens via UI later
  })

  log.info("API token issued via terraform login", { userId: pending.userId })

  // Return token in OAuth format
  return c.json({
    access_token: token,
    token_type: "bearer",
    // TFC doesn't use refresh tokens for CLI auth
  })
})

/**
 * Consent page (optional - for showing what permissions will be granted)
 * For now, we auto-approve since it's the user's own account.
 */
oauthCliRoute.get("/consent", async (c) => {
  // TODO: Implement consent UI if needed
  // For now, the authorize endpoint auto-approves
  return c.text("Consent page - not implemented")
})
