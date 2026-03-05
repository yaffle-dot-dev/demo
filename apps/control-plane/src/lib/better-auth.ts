import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { db } from "./db"
import { getEnv } from "./env"

const env = getEnv()

// Trusted origins for OAuth callbacks
// In dev: frontend runs on :5173, API on :3000
// In prod: both on same domain
const trustedOrigins = env.trustedOrigins
  ? env.trustedOrigins.split(",").map((o) => o.trim())
  : ["http://localhost:5173", "http://localhost:3000"]

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  basePath: "/api/auth",
  baseURL: env.betterAuthUrl || "http://localhost:3000",
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
})

export type Session = typeof auth.$Infer.Session
