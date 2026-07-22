import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "@yaffle/test"
import { createHash } from "node:crypto"

import { eq } from "drizzle-orm"
import { Hono } from "hono"

import { auth } from "../lib/better-auth.ts"
import { db } from "../lib/db.ts"
import { resetRateLimitStore } from "../lib/request-protection.ts"
import {
  DEFAULT_ANONYMOUS_SESSION_TTL_DAYS,
  generateAnonymousSessionToken,
  verifyAccountPrincipalToken,
} from "../lib/principal-tokens.ts"
import { cleanupTestData } from "../test-utils/auth.ts"
import {
  anonymousSessions,
  cloudCliAuthorizationCodes,
  hostedOutputModules,
  principalRepoBindings,
  principals,
  user,
} from "../db/schema.ts"
import {
  createAnonymousSession,
  createPrincipal,
  ensurePrincipalRepoBinding,
  publishHostedOutputModule,
} from "../db/queries/principals.ts"
import { cloudCliRoute } from "./cloud-cli.ts"
import { localFirstRoute } from "./local-first.ts"

const TEST_USER_ID = "cloud-cli-test-user"
let app: Hono
let originalGetSession: typeof auth.api.getSession
let originalBetterAuthSecret: string | undefined

async function ensureTestUserRecord(): Promise<void> {
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1)
  if (existingUser.length === 0) {
    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "Cloud CLI Test User",
      email: "cloud-cli-test@example.com",
      emailVerified: true,
    })
  }
}

beforeAll(async () => {
  originalGetSession = auth.api.getSession.bind(auth.api) as typeof auth.api.getSession
  originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET
  await ensureTestUserRecord()
})

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "cloud-cli-test-secret-at-least-32-characters"
  resetRateLimitStore()
  await cleanupTestData()
  await db
    .delete(cloudCliAuthorizationCodes)
    .where(eq(cloudCliAuthorizationCodes.userId, TEST_USER_ID))

  auth.api.getSession = (async () => ({
    session: {
      id: "session-1",
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60_000),
      token: "session-token",
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: TEST_USER_ID,
      email: "cloud-cli-test@example.com",
      name: "Cloud CLI Test User",
      image: null,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  })) as typeof auth.api.getSession

  app = new Hono()
  app.route("/api/cloud", cloudCliRoute)
  app.route("/api", localFirstRoute)
})

afterEach(async () => {
  auth.api.getSession = originalGetSession
  if (originalBetterAuthSecret) {
    process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret
  } else {
    delete process.env.BETTER_AUTH_SECRET
  }
  resetRateLimitStore()
  await cleanupTestData()
  await db
    .delete(cloudCliAuthorizationCodes)
    .where(eq(cloudCliAuthorizationCodes.userId, TEST_USER_ID))
})

afterAll(() => {
  auth.api.getSession = originalGetSession
})

describe("cloudCliRoute", () => {
  test("authorizes CLI login without putting the feature token in the browser URL", async () => {
    const codeVerifier = "b".repeat(43)
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")

    const requestRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/authorize-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: "yaffle-cli",
          redirect_port: 10000,
          response_type: "code",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state: "cloud-login-state",
        }),
      }),
    )

    expect(requestRes.status).toBe(200)
    const requestBody = (await requestRes.json()) as { data: { authorizeUrl: string } }
    expect(requestBody.data.authorizeUrl).toContain("/api/cloud/cli/authorize?request=")
    expect(requestBody.data.authorizeUrl).not.toContain("localhost:10000")
    expect(requestBody.data.authorizeUrl).not.toContain("redirect_uri")
    expect(requestBody.data.authorizeUrl).not.toContain("feature_token")

    const authorizeRes = await app.fetch(new Request(requestBody.data.authorizeUrl))

    expect(authorizeRes.status).toBe(200)
    const authorizeHtml = await authorizeRes.text()
    expect(authorizeHtml).toContain("Yaffle Cloud login approved")
    expect(authorizeHtml).not.toContain("feature_token")
  })

  test("creates a browser authorize request without a client secret", async () => {
    const codeChallenge = createHash("sha256").update("f".repeat(43)).digest("base64url")
    const requestRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/authorize-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: "yaffle-cli",
          redirect_port: 10000,
          response_type: "code",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state: "public-client-state",
        }),
      }),
    )

    expect(requestRes.status).toBe(200)
  })

  test("rejects a malformed PKCE challenge", async () => {
    const requestRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/authorize-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "yaffle-cli",
          redirect_port: 10000,
          response_type: "code",
          code_challenge: "+".repeat(43),
          code_challenge_method: "S256",
        }),
      }),
    )

    expect(requestRes.status).toBe(400)
  })

  test("strips legacy feature tokens before redirecting unauthenticated users to login", async () => {
    auth.api.getSession = (async () => null) as typeof auth.api.getSession

    const redirectUri = "http://localhost:10000/callback"
    const authorizeParams = new URLSearchParams({
      client_id: "yaffle-cli",
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: "e".repeat(43),
      code_challenge_method: "S256",
      state: "cloud-login-state",
      feature_token: "legacy-token-must-not-propagate",
    })

    const authorizeRes = await app.fetch(
      new Request(`http://localhost/api/cloud/cli/authorize?${authorizeParams.toString()}`),
    )

    expect(authorizeRes.status).toBe(200)
    const authorizeHtml = await authorizeRes.text()
    expect(authorizeHtml).toContain("Redirecting to GitHub")
    expect(authorizeHtml).not.toContain("legacy-token-must-not-propagate")
    expect(authorizeHtml).not.toContain("feature_token")
    expect(authorizeHtml).not.toContain("localhost:10000")
    expect(authorizeHtml).not.toContain("redirect_uri")
    expect(authorizeHtml).toContain("/api/cloud/cli/authorize")
  })

  test("rejects malformed public-client token exchanges", async () => {
    const tokenRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    )

    expect(tokenRes.status).toBe(400)
  })

  test("issues an account principal token and can use it for local-first execution tokens", async () => {
    const redirectUri = "http://localhost:10000/callback"
    const codeVerifier = "c".repeat(43)
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    const authorizeParams = new URLSearchParams({
      client_id: "yaffle-cli",
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: "cloud-login-state",
      feature_token: "legacy-token-must-not-propagate",
    })

    const authorizeRes = await app.fetch(
      new Request(`http://localhost/api/cloud/cli/authorize?${authorizeParams.toString()}`),
    )
    expect(authorizeRes.status).toBe(200)

    const authorizeHtml = await authorizeRes.text()
    const redirectMatch = authorizeHtml.match(
      /http:\/\/localhost:10000\/callback\?code=([^"&]+)&state=cloud-login-state/,
    )
    expect(redirectMatch).toBeTruthy()
    const code = redirectMatch?.[1] ?? ""
    const tokenRequest = {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_port: 10000,
      client_id: "yaffle-cli",
    }

    const wrongVerifierRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tokenRequest, code_verifier: "w".repeat(43) }),
      }),
    )
    expect(wrongVerifierRes.status).toBe(400)

    const tokenRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tokenRequest),
      }),
    )

    expect(tokenRes.status).toBe(200)
    const tokenBody = (await tokenRes.json()) as {
      data: {
        principalId: string
        principalType: string
        token: string
        userId: string
      }
    }
    expect(tokenBody.data.principalType).toBe("account")

    const replayRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokenRequest),
      }),
    )
    expect(replayRes.status).toBe(400)

    const payload = await verifyAccountPrincipalToken(tokenBody.data.token)
    expect(payload?.principal_id).toBe(tokenBody.data.principalId)
    expect(payload?.user_id).toBe(TEST_USER_ID)

    const executionTokenRes = await app.fetch(
      new Request("http://localhost/api/execution-tokens", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenBody.data.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          consumerWorkspacePath: "apps/web/infra",
        }),
      }),
    )
    expect(executionTokenRes.status).toBe(201)

    const principalRows = await db
      .select()
      .from(principals)
      .where(eq(principals.id, tokenBody.data.principalId))
    expect(principalRows[0]).toMatchObject({
      type: "account",
      userId: TEST_USER_ID,
      status: "active",
    })
  })

  test("converts an active anonymous principal into the account principal", async () => {
    const anonymousPrincipal = await createPrincipal({
      type: "anonymous_session",
    })
    const anonymousSession = await createAnonymousSession({
      principalId: anonymousPrincipal.id,
      expiresAt: new Date(Date.now() + DEFAULT_ANONYMOUS_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    const anonymousToken = await generateAnonymousSessionToken({
      principalId: anonymousPrincipal.id,
      sessionId: anonymousSession.id,
    })
    const binding = await ensurePrincipalRepoBinding({
      principalId: anonymousPrincipal.id,
      canonicalRepoNamespace: "test-org--fixture",
      localRepoFingerprint: "repo-fingerprint-1",
    })
    await publishHostedOutputModule({
      principalId: anonymousPrincipal.id,
      repoBindingId: binding.id,
      canonicalRepoNamespace: "test-org--fixture",
      environmentName: "main",
      workspacePath: "infra/shared",
      stateFingerprint: "state-md5-1",
      outputs: {},
    })

    const redirectUri = "http://localhost:10000/callback"
    const codeVerifier = "d".repeat(43)
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    const authorizeParams = new URLSearchParams({
      client_id: "yaffle-cli",
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    })

    const authorizeRes = await app.fetch(
      new Request(`http://localhost/api/cloud/cli/authorize?${authorizeParams.toString()}`),
    )
    const authorizeHtml = await authorizeRes.text()
    const redirectMatch = authorizeHtml.match(/http:\/\/localhost:10000\/callback\?code=([^"&]+)/)
    const code = redirectMatch?.[1] ?? ""

    const tokenRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_port: 10000,
          client_id: "yaffle-cli",
          current_principal_token: anonymousToken,
        }),
      }),
    )
    expect(tokenRes.status).toBe(200)

    const tokenBody = (await tokenRes.json()) as {
      data: {
        principalId: string
        convertedFromAnonymous: boolean
      }
    }
    expect(tokenBody.data.convertedFromAnonymous).toBe(true)

    const oldPrincipalRows = await db
      .select()
      .from(principals)
      .where(eq(principals.id, anonymousPrincipal.id))
    const accountBindingRows = await db
      .select()
      .from(principalRepoBindings)
      .where(eq(principalRepoBindings.principalId, tokenBody.data.principalId))
    const movedModuleRows = await db
      .select()
      .from(hostedOutputModules)
      .where(eq(hostedOutputModules.principalId, tokenBody.data.principalId))
    const sessionRows = await db
      .select()
      .from(anonymousSessions)
      .where(eq(anonymousSessions.id, anonymousSession.id))

    expect(oldPrincipalRows[0]?.status).toBe("revoked")
    expect(sessionRows[0]?.status).toBe("revoked")
    expect(accountBindingRows).toHaveLength(1)
    expect(movedModuleRows).toHaveLength(1)
    expect(movedModuleRows[0]?.repoBindingId).toBe(accountBindingRows[0]?.id)
  })
})
