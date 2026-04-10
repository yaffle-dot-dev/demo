import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import { apikey as apiKeyTable, user as userTable } from "../db/auth-schema.ts"
import type { Session } from "./better-auth.ts"

const mockGetSession = mock(async (_args: { headers: Headers }) => null as Session | null)
const mockVerifyApiKey = mock(async (_args: { body: { key: string; permissions?: unknown } }) => ({ valid: false, key: null as null | { id: string; referenceId: string } }))
const mockDbSelect = mock((_shape?: unknown): any => ({
  from: (table: unknown) => ({
    where: () => ({
      limit: async () => {
        if (table === userTable) {
          return []
        }
        if (table === apiKeyTable) {
          return []
        }
        return []
      },
    }),
  }),
}))

let requireAuth: typeof import("./auth.ts").requireAuth
let authModule: typeof import("./better-auth.ts")
let dbModule: typeof import("./db.ts")
let originalGetSession: typeof import("./better-auth.ts").auth.api.getSession
let originalVerifyApiKey: typeof import("./better-auth.ts").auth.api.verifyApiKey
let originalDbSelect: typeof import("./db.ts").db.select

beforeAll(async () => {
  authModule = await import("./better-auth.ts")
  dbModule = await import("./db.ts")
  ;({ requireAuth } = await import("./auth.ts"))

  originalGetSession = authModule.auth.api.getSession
  originalVerifyApiKey = authModule.auth.api.verifyApiKey
  originalDbSelect = dbModule.db.select
})

afterAll(() => {
  mock.restore()
})

afterEach(() => {
  authModule.auth.api.getSession = originalGetSession
  authModule.auth.api.verifyApiKey = originalVerifyApiKey
  dbModule.db.select = originalDbSelect
})

beforeEach(() => {
  mockGetSession.mockReset()
  mockVerifyApiKey.mockReset()
  mockDbSelect.mockReset()

  authModule.auth.api.getSession = mockGetSession as typeof authModule.auth.api.getSession
  authModule.auth.api.verifyApiKey = mockVerifyApiKey as typeof authModule.auth.api.verifyApiKey
  dbModule.db.select = mockDbSelect as typeof dbModule.db.select

  mockGetSession.mockImplementation(async ({ headers }: { headers: Headers }) => {
    const cookie = headers.get("cookie")
    if (cookie?.includes("better-auth.session_token=valid-session-token")) {
      return {
        session: {
          id: "session-1",
          userId: "user-1",
          expiresAt: new Date(Date.now() + 60_000),
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
      } as Session
    }

    return null
  })

  mockVerifyApiKey.mockImplementation(async () => ({ valid: false, key: null }))

  mockDbSelect.mockImplementation((_shape?: unknown) => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === userTable) {
            return []
          }
          if (table === apiKeyTable) {
            return []
          }
          return []
        },
      }),
    }),
  }))
})

describe("requireAuth transport hardening", () => {
  test("rejects Better Auth session token in Authorization header", async () => {
    const headers = new Headers({
      authorization: "Bearer valid-session-token",
    })

    await expect(requireAuth(headers)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    })
  })

  test("rejects Better Auth session token in query token option", async () => {
    await expect(
      requireAuth(new Headers(), { token: "valid-session-token" }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    })
  })

  test("still accepts cookie-backed Better Auth sessions", async () => {
    const headers = new Headers({
      cookie: "better-auth.session_token=valid-session-token",
    })

    await expect(requireAuth(headers)).resolves.toMatchObject({
      userId: "user-1",
      email: "user@example.com",
    })
  })

  test("accepts API keys with required permissions and metadata", async () => {
    mockVerifyApiKey.mockImplementation(async ({ body }: { body: { key: string; permissions?: unknown } }) => {
      if (body.key !== "yfl_valid") {
        return { valid: false, key: null }
      }

      return {
        valid: true,
        key: {
          id: "key-1",
          referenceId: "user-1",
        },
      }
    })

    mockDbSelect.mockImplementation((_shape?: unknown): any => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === userTable) {
              return [{
                id: "user-1",
                email: "user@example.com",
                name: "Test User",
                image: null,
              }]
            }

            if (table === apiKeyTable) {
              return [{
                id: "key-1",
                metadata: JSON.stringify({ orgId: "org-1", access: "read" }),
                permissions: JSON.stringify({ yaffle: ["read"] }),
              }]
            }

            return []
          },
        }),
      }),
    }))

    await expect(
      requireAuth(new Headers({ authorization: "Bearer yfl_valid" }), {
        apiKeyPermissions: { yaffle: ["read"] },
      }),
    ).resolves.toMatchObject({
      userId: "user-1",
      apiKeyId: "key-1",
      apiKeyMetadata: { orgId: "org-1", access: "read" },
    })
  })
})
