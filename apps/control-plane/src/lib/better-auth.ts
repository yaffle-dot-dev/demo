import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { apiKey } from "@better-auth/api-key"
import { db } from "./db"
import { getEnv } from "./env"

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
  plugins: [
    apiKey({
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
    }),
  ],
})

export type Session = typeof auth.$Infer.Session
