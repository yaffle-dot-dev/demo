import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createHash } from "node:crypto"

import { eq } from "drizzle-orm"

import { auth } from "../../lib/better-auth.ts"
import { db } from "../../lib/db.ts"
import { createOrg, findOrgBySlug } from "../../db/queries/organizations.ts"
import { ensureMembership } from "../../db/queries/users.ts"
import { apiTokens, oauthAuthorizationCodes, user } from "../../db/schema.ts"

import { oauthCliRoute } from "./oauth-cli.ts"

const TEST_USER_ID = "oauth-cli-test-user"
const TEST_ORG_SLUG = "oauth-cli-test-org"

let testOrgId: string
let app: Hono
let originalGetSession: typeof auth.api.getSession

async function ensureTestUserRecord(): Promise<void> {
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1)
  if (existingUser.length === 0) {
    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "OAuth CLI Test User",
      email: "oauth-cli-test@example.com",
      emailVerified: true,
    })
  }
}

beforeAll(async () => {
  originalGetSession = auth.api.getSession

  await ensureTestUserRecord()

  let org = await findOrgBySlug(TEST_ORG_SLUG)
  if (!org) {
    org = await createOrg({
      name: "OAuth CLI Test Org",
      slug: TEST_ORG_SLUG,
    })
  }
  testOrgId = org.id

  await ensureMembership({
    orgId: testOrgId,
    userId: TEST_USER_ID,
    role: "admin",
    source: "manual",
  })
})

beforeEach(async () => {
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
      email: "oauth-cli-test@example.com",
      name: "OAuth CLI Test User",
      image: null,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  })) as typeof auth.api.getSession

  await db.delete(apiTokens).where(eq(apiTokens.userId, TEST_USER_ID))
  await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, TEST_USER_ID))

  app = new Hono()
  app.route("/tfc/oauth", oauthCliRoute)
})

afterEach(() => {
  auth.api.getSession = originalGetSession
})

afterAll(async () => {
  auth.api.getSession = originalGetSession
  await db.delete(apiTokens).where(eq(apiTokens.userId, TEST_USER_ID))
  await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, TEST_USER_ID))
})

describe("oauthCliRoute", () => {
  test("exchanges an authorization code and invalidates it after use", async () => {
    const redirectUri = "http://localhost:10000/callback"
    const codeVerifier = "c".repeat(43)
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    const authorizeParams = new URLSearchParams({
      client_id: "terraform-cli",
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      organization: TEST_ORG_SLUG,
      state: "oauth-state",
    })

    const authorizeRes = await app.fetch(
      new Request(`http://localhost/tfc/oauth/authorize?${authorizeParams.toString()}`),
    )

    expect(authorizeRes.status).toBe(200)

    const authorizeHtml = await authorizeRes.text()
    const redirectMatch = authorizeHtml.match(
      /http:\/\/localhost:10000\/callback\?code=([^"&]+)&state=oauth-state/,
    )

    expect(redirectMatch).toBeTruthy()
    const code = redirectMatch?.[1] ?? ""
    expect(code).toBeTruthy()

    const tokenRequestBody = {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: "terraform-cli",
    }

    const tokenRes = await app.fetch(
      new Request("http://localhost/tfc/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tokenRequestBody),
      }),
    )

    expect(tokenRes.status).toBe(200)

    const tokenBody = await tokenRes.json() as { access_token?: string; token_type?: string }
    expect(tokenBody.token_type).toBe("bearer")
    expect(typeof tokenBody.access_token).toBe("string")
    expect(tokenBody.access_token).toBeTruthy()

    const createdTokens = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, TEST_USER_ID))

    expect(createdTokens).toHaveLength(1)
    expect(createdTokens[0]).toMatchObject({
      userId: TEST_USER_ID,
      orgId: testOrgId,
      description: `terraform login (${TEST_ORG_SLUG})`,
      createdByFlow: "terraform_login",
    })

    const secondTokenRes = await app.fetch(
      new Request("http://localhost/tfc/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tokenRequestBody),
      }),
    )

    expect(secondTokenRes.status).toBe(400)
    expect(await secondTokenRes.json()).toEqual({
      error: "invalid_grant",
      error_description: "Invalid or expired code",
    })
  })
})
