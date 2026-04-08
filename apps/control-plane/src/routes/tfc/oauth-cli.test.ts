import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { createHash } from "node:crypto"

type StoredAuthorizationCode = {
  userId: string
  orgId: string
  orgSlug: string
  scopes: string[]
  codeChallenge: string
  codeChallengeMethod: string
  redirectUri: string
  expiresAt: Date
}

const storedCodes = new Map<string, StoredAuthorizationCode>()
const createdApiTokens: Array<Record<string, unknown>> = []

const mockGetSession = mock(async () => ({
  session: {
    id: "session-1",
    userId: "user-1",
    expiresAt: new Date(Date.now() + 60_000),
    token: "session-token",
    createdAt: new Date(),
    updatedAt: new Date(),
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "user-1",
    email: "user@example.com",
    name: "Test User",
    image: null,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
}))

const mockCreateApiToken = mock(async (values: Record<string, unknown>) => {
  createdApiTokens.push(values)
  return values
})

const mockGenerateToken = mock(() => ({
  token: "oauth-token-1",
  hash: "oauth-token-hash-1",
}))

const mockGetDefaultTfcScopesForRole = mock(() => [
  "workspace:read",
  "workspace:write",
  "workspace:lock",
  "state:read",
  "state:write",
  "state:download",
  "admin:force_unlock",
])

const mockGetDefaultTfcTokenExpiry = mock(() => new Date("2026-01-01T00:00:00.000Z"))

const mockListUserOrgs = mock(async () => [
  {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    role: "admin",
  },
])

const mockCreateOauthAuthorizationCode = mock(
  async (input: { code: string } & StoredAuthorizationCode) => {
    storedCodes.set(input.code, {
      userId: input.userId,
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      scopes: input.scopes,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      redirectUri: input.redirectUri,
      expiresAt: input.expiresAt,
    })
  },
)

const mockTakeOauthAuthorizationCode = mock(async (code: string) => {
  const pending = storedCodes.get(code)
  storedCodes.delete(code)
  return pending
})

const mockEnforceRateLimit = mock(() => null)
const mockReadRequestBodyText = mock(async (request: Request) => await request.text())

mock.module("../../lib/better-auth.ts", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}))

mock.module("../../db/queries/api-tokens.ts", () => ({
  createApiToken: mockCreateApiToken,
  generateToken: mockGenerateToken,
  getDefaultTfcScopesForRole: mockGetDefaultTfcScopesForRole,
  getDefaultTfcTokenExpiry: mockGetDefaultTfcTokenExpiry,
}))

mock.module("../../db/queries/oauth-authorization-codes.ts", () => ({
  createOauthAuthorizationCode: mockCreateOauthAuthorizationCode,
  takeOauthAuthorizationCode: mockTakeOauthAuthorizationCode,
}))

mock.module("../../db/queries/users.ts", () => ({
  listUserOrgs: mockListUserOrgs,
}))

mock.module("../../lib/request-protection.ts", () => ({
  enforceRateLimit: mockEnforceRateLimit,
  readRequestBodyText: mockReadRequestBodyText,
  RequestBodyTooLargeError: class RequestBodyTooLargeError extends Error {},
}))

mock.module("../../lib/public-origin.ts", () => ({
  buildPublicUrl: (_requestUrl: string, path: string) => `https://yaffle.dev${path}`,
}))

mock.module("../../lib/telemetry.ts", () => ({
  logger: {
    info: () => {},
    warn: () => {},
  },
}))

let app: Hono

beforeAll(async () => {
  const { oauthCliRoute } = await import("./oauth-cli.ts")
  app = new Hono()
  app.route("/tfc/oauth", oauthCliRoute)
})

beforeEach(() => {
  storedCodes.clear()
  createdApiTokens.length = 0

  mockGetSession.mockClear()
  mockCreateApiToken.mockClear()
  mockGenerateToken.mockClear()
  mockGetDefaultTfcScopesForRole.mockClear()
  mockGetDefaultTfcTokenExpiry.mockClear()
  mockListUserOrgs.mockClear()
  mockCreateOauthAuthorizationCode.mockClear()
  mockTakeOauthAuthorizationCode.mockClear()
  mockEnforceRateLimit.mockClear()
  mockReadRequestBodyText.mockClear()
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
      organization: "acme",
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
    expect(await tokenRes.json()).toEqual({
      access_token: "oauth-token-1",
      token_type: "bearer",
    })
    expect(createdApiTokens).toHaveLength(1)
    expect(createdApiTokens[0]).toMatchObject({
      userId: "user-1",
      orgId: "org-1",
      description: "terraform login (acme)",
      tokenHash: "oauth-token-hash-1",
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
