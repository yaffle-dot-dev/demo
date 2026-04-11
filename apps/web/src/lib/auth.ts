import { createAuthClient } from "better-auth/svelte"
import type { BetterAuthClientPlugin } from "better-auth"
import { apiKeyClient, type ApiKeyClientPlugin } from "@better-auth/api-key/client"
import { readable } from "svelte/store"

// Storage key for last org (kept for UX convenience)
const LAST_ORG_KEY = "yaffle.lastOrg"
const SMOKE_AUTH_ENABLED = import.meta.env.VITE_YAFFLE_SMOKE_AUTH === "true"

type SmokeAuthUser = {
  id: string
  email: string
  name: string
  image?: string | null
}

function parseSmokeAuthUser(): SmokeAuthUser | null {
  const raw = import.meta.env.VITE_YAFFLE_SMOKE_AUTH_USER_JSON
  if (!raw) {
    return {
      id: "smoke-user",
      email: "smoke@yaffle.dev",
      name: "smoke-user",
      image: null,
    }
  }

  if (raw.trim().toLowerCase() === "null") {
    return null
  }

  try {
    return JSON.parse(raw) as SmokeAuthUser
  } catch {
    return {
      id: "smoke-user",
      email: "smoke@yaffle.dev",
      name: "smoke-user",
      image: null,
    }
  }
}

function getSmokeSessionState() {
  const user = parseSmokeAuthUser()

  return {
    data: user
      ? {
          session: {
            id: "smoke-session",
            userId: user.id,
            expiresAt: "2999-01-01T00:00:00.000Z",
          },
          user,
        }
      : null,
    error: null,
    isPending: false,
    refetch: async () => getSmokeSessionState(),
  }
}

function getApiUrl(): string {
  const env = import.meta.env.VITE_YAFFLE_API_URL ?? ""
  if (env) {
    return env.trim().replace(/\/+$/, "")
  }
  // Default: same origin (works with Caddy reverse proxy in dev and production)
  if (typeof window !== "undefined") {
    return window.location.origin
  }
  // During SSR, auth client is never actually used (all auth logic runs in onMount/browser only).
  // Return a placeholder to avoid crashing module initialization.
  return "http://localhost"
}

// Create the BetterAuth client
// This automatically handles session management via cookies
const apiKeyPlugin = apiKeyClient() as unknown as ApiKeyClientPlugin & BetterAuthClientPlugin

export const authClient = createAuthClient({
  baseURL: getApiUrl(),
  plugins: [apiKeyPlugin],
})

// Re-export commonly used methods for convenience
export const {
  signIn,
  signOut,
} = authClient

export function useSession(): ReturnType<typeof authClient.useSession> {
  if (SMOKE_AUTH_ENABLED) {
    return readable(getSmokeSessionState()) as unknown as ReturnType<typeof authClient.useSession>
  }

  return authClient.useSession()
}

export async function getSession(): Promise<Awaited<ReturnType<typeof authClient.getSession>>> {
  if (SMOKE_AUTH_ENABLED) {
    return getSmokeSessionState() as Awaited<ReturnType<typeof authClient.getSession>>
  }

  return authClient.getSession()
}

/**
 * Start GitHub OAuth login flow.
 * BetterAuth handles the OAuth dance and redirects back to the callback URL.
 */
export async function startGithubLogin(): Promise<void> {
  const callbackURL = `${window.location.origin}/app/auth/callback`
  await signIn.social({
    provider: "github",
    callbackURL,
  })
}

/**
 * Log out the current user.
 * Clears the session cookie and redirects to home.
 */
export async function logout(): Promise<void> {
  await signOut()
  // Clear local storage preferences
  localStorage.removeItem(LAST_ORG_KEY)
  window.location.href = "/app/"
}

/**
 * Get the current session synchronously from the store.
 * Returns null if not logged in.
 */
export function getSessionSync() {
  const session = useSession()
  return session
}

/**
 * Check if the user is currently logged in.
 * This is a reactive Svelte store.
 */
export function isLoggedIn(): boolean {
  const session = useSession()
  // useSession returns a store, we need to access its value
  let value: boolean = false
  session.subscribe((s) => {
    value = !!s.data?.user
  })()
  return value
}

/**
 * Get the current user's login/username.
 * Returns null if not logged in.
 */
export function getUserLogin(): string | null {
  const session = useSession()
  let login: string | null = null
  session.subscribe((s) => {
    login = s.data?.user?.name ?? null
  })()
  return login
}

// Last org helpers (UX preference, not auth-related)
export function getLastOrg(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(LAST_ORG_KEY)
}

export function setLastOrg(org: string): void {
  if (typeof window === "undefined") return
  localStorage.setItem(LAST_ORG_KEY, org)
}
