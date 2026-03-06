import { createAuthClient } from "better-auth/svelte"

// Storage key for last org (kept for UX convenience)
const LAST_ORG_KEY = "yaffle.lastOrg"

function getApiUrl(): string {
  const env = import.meta.env.VITE_YAFFLE_API_URL ?? ""
  if (env) {
    return env.trim().replace(/\/+$/, "")
  }
  // Default: same origin (works with Caddy reverse proxy in dev and production)
  if (typeof window !== "undefined") {
    return window.location.origin
  }
  return "http://localhost:3000"
}

// Create the BetterAuth client
// This automatically handles session management via cookies
export const authClient = createAuthClient({
  baseURL: getApiUrl(),
})

// Re-export commonly used methods for convenience
export const {
  signIn,
  signOut,
  useSession,
  getSession,
} = authClient

/**
 * Start GitHub OAuth login flow.
 * BetterAuth handles the OAuth dance and redirects back to the callback URL.
 */
export async function startGithubLogin(): Promise<void> {
  const callbackURL = `${window.location.origin}/auth/callback`
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
  window.location.href = "/"
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
