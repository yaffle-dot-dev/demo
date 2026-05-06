import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
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
const TEST_FEATURE_TOKEN = "test-feature-token"

let app: Hono
let originalGetSession: typeof auth.api.getSession

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

function featureHeaders(): Record<string, string> {
  return {
    "feature-token": TEST_FEATURE_TOKEN,
  }
}

beforeAll(async () => {
  originalGetSession = auth.api.getSession
  await ensureTestUserRecord()
})

beforeEach(async () => {
  process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN = TEST_FEATURE_TOKEN
  resetRateLimitStore()
  await cleanupTestData()
  await db.delete(cloudCliAuthorizationCodes).where(eq(cloudCliAuthorizationCodes.userId, TEST_USER_ID))

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
  delete process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN
  resetRateLimitStore()
  await cleanupTestData()
  await db.delete(cloudCliAuthorizationCodes).where(eq(cloudCliAuthorizationCodes.userId, TEST_USER_ID))
})

afterAll(() => {
  auth.api.getSession = originalGetSession
})

describe("cloudCliRoute", () => {
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
      feature_token: TEST_FEATURE_TOKEN,
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

    const tokenRes = await app.fetch(
      new Request("http://localhost/api/cloud/cli/token", {
        method: "POST",
        headers: {
          ...featureHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: "yaffle-cli",
        }),
      }),
    )

    expect(tokenRes.status).toBe(200)
    const tokenBody = await tokenRes.json() as {
      data: {
        principalId: string
        principalType: string
        token: string
        userId: string
      }
    }
    expect(tokenBody.data.principalType).toBe("account")

    const payload = await verifyAccountPrincipalToken(tokenBody.data.token)
    expect(payload?.principal_id).toBe(tokenBody.data.principalId)
    expect(payload?.user_id).toBe(TEST_USER_ID)

    const executionTokenRes = await app.fetch(
      new Request("http://localhost/api/execution-tokens", {
        method: "POST",
        headers: {
          ...featureHeaders(),
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
      feature_token: TEST_FEATURE_TOKEN,
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
          ...featureHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: "yaffle-cli",
          current_principal_token: anonymousToken,
        }),
      }),
    )
    expect(tokenRes.status).toBe(200)

    const tokenBody = await tokenRes.json() as {
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
