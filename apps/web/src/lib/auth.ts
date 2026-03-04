import { createClient } from "@openauthjs/openauth/client"

// Storage keys - centralized to avoid mismatches
const STORAGE_KEYS = {
  accessToken: "yaffle.accessToken",
  refreshToken: "yaffle.refreshToken",
  userLogin: "yaffle.userLogin",
  userId: "yaffle.userId",
  challenge: "yaffle.authChallenge",
  lastOrg: "yaffle.lastOrg",
} as const

function getIssuerUrl(): string {
  const env = import.meta.env.VITE_YAFFLE_AUTH_ISSUER ?? ""
  if (env) {
    // Remove trailing slash
    return env.trim().replace(/\/+$/, "")
  }
  // Default for local development - OpenAuth is mounted at root
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:3000`
  }
  return "http://localhost:3000"
}

const issuer = getIssuerUrl()
const clientId = import.meta.env.VITE_YAFFLE_AUTH_CLIENT_ID ?? "yaffle-web"

const client = createClient({ clientID: clientId, issuer })

export async function startGithubLogin(): Promise<void> {
  const redirectUri = `${window.location.origin}/auth/callback`
  const { url, challenge } = await client.authorize(redirectUri, "code", {
    pkce: true,
    provider: "github",
  })
  if (challenge) {
    sessionStorage.setItem(STORAGE_KEYS.challenge, JSON.stringify(challenge))
  }
  window.location.href = url
}

export interface ExchangeResult {
  accessToken: string
  refreshToken: string
}

export async function exchangeCode(code: string): Promise<ExchangeResult> {
  const redirectUri = `${window.location.origin}/auth/callback`
  const challengeRaw = sessionStorage.getItem(STORAGE_KEYS.challenge)
  const challenge = challengeRaw ? JSON.parse(challengeRaw) : undefined

  // Clear challenge immediately to prevent replay
  sessionStorage.removeItem(STORAGE_KEYS.challenge)

  const result = await client.exchange(code, redirectUri, challenge?.verifier)
  if ("err" in result && result.err) {
    throw new Error(result.err.message ?? "Token exchange failed")
  }
  if (!result.tokens) {
    throw new Error("No tokens received from auth server")
  }

  const { access, refresh } = result.tokens
  localStorage.setItem(STORAGE_KEYS.accessToken, access)
  localStorage.setItem(STORAGE_KEYS.refreshToken, refresh)

  return { accessToken: access, refreshToken: refresh }
}

export function storeUserInfo(login: string, userId: string): void {
  localStorage.setItem(STORAGE_KEYS.userLogin, login)
  localStorage.setItem(STORAGE_KEYS.userId, userId)
}

export function logout(): void {
  localStorage.removeItem(STORAGE_KEYS.accessToken)
  localStorage.removeItem(STORAGE_KEYS.refreshToken)
  localStorage.removeItem(STORAGE_KEYS.userLogin)
  localStorage.removeItem(STORAGE_KEYS.userId)
}

export function getAccessToken(): string | null {
  return localStorage.getItem(STORAGE_KEYS.accessToken)
}

export function getUserLogin(): string | null {
  return localStorage.getItem(STORAGE_KEYS.userLogin)
}

export function isLoggedIn(): boolean {
  return !!getAccessToken()
}

export function getLastOrg(): string | null {
  return localStorage.getItem(STORAGE_KEYS.lastOrg)
}

export function setLastOrg(org: string): void {
  localStorage.setItem(STORAGE_KEYS.lastOrg, org)
}
