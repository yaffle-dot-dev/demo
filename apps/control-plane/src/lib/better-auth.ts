import { betterAuth } from "better-auth"
import type { BetterAuthPlugin } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { apiKey } from "@better-auth/api-key"
import { db } from "./db"
import { getEnv } from "./env"

export interface Session {
  session: {
    id: string
    userId: string
    expiresAt: Date
    token?: string
    createdAt?: Date
    updatedAt?: Date
    ipAddress?: string | null
    userAgent?: string | null
  }
  user: {
    id: string
    email: string
    name: string
    image?: string | null
    emailVerified?: boolean
    createdAt?: Date
    updatedAt?: Date
  }
}

type ApiKeyPermissions = Record<string, string[]>

type VerifyApiKeyResult = {
  valid: boolean
  key: {
    id: string
    referenceId: string
  } | null
}

type ListedApiKey = {
  id: string
  name: string | null
  start: string | null
  createdAt: Date | string
  expiresAt: Date | string | null
  enabled: boolean
  metadata?: unknown
}

type CreatedApiKey = {
  id: string
  key: string
  name: string | null
  expiresAt: Date | string | null
}

type AuthApi = {
  getSession(args: { headers: Headers }): Promise<Session | null>
  verifyApiKey(args: { body: { key: string; permissions?: ApiKeyPermissions } }): Promise<VerifyApiKeyResult>
  listApiKeys(args: { headers: Headers }): Promise<{ apiKeys?: ListedApiKey[] }>
  createApiKey(args: {
    body: {
      name: string
      expiresIn: number
      userId: string
      metadata: Record<string, unknown>
      permissions: ApiKeyPermissions
    }
  }): Promise<CreatedApiKey>
  deleteApiKey(args: { headers: Headers; body: { keyId: string } }): Promise<unknown>
}

type AuthInstance = {
  handler(request: Request): Response | Promise<Response>
  api: AuthApi
  $Infer: {
    Session: Session
  }
}

const env = getEnv()

// Trusted origins for OAuth callbacks
// In dev: frontend runs on :5173, API on :3000
// In prod: both on same domain
if (!env.betterAuthUrl) {
  throw new Error("BETTER_AUTH_URL must be configured")
}

const trustedOrigins = env.trustedOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)

if (trustedOrigins.length === 0) {
  throw new Error("TRUSTED_ORIGINS must be configured")
}

const apiKeyPlugin = apiKey({
  // Prefix for easy identification (e.g., yfl_abc123...)
  defaultPrefix: "yfl_",
  enableMetadata: true,
  // API keys for CLI/CI access
  keyExpiration: {
    // Default expiration: 90 days (in seconds)
    defaultExpiresIn: 60 * 60 * 24 * 90,
    minExpiresIn: 7,
    maxExpiresIn: 365,
  },
  permissions: {
    defaultPermissions: {
      yaffle: ["read"],
    },
  },
}) as unknown as ReturnType<typeof apiKey> & BetterAuthPlugin

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  basePath: "/api/auth",
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  trustedOrigins,
  emailAndPassword: {
    enabled: false, // GitHub only for now
  },
  socialProviders: {
    github: {
      clientId: env.githubOauthClientId,
      clientSecret: env.githubOauthClientSecret,
      scope: ["read:user", "read:org"],
    },
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  advanced: {
    crossSubDomainCookies: {
      enabled: false, // Same domain for now
    },
  },
  plugins: [apiKeyPlugin],
}) as unknown as AuthInstance
