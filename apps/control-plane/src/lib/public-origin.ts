import { getEnv } from "./env.ts"

export function getPublicOrigin(requestUrl: string): string {
  const env = getEnv()

  if (env.betterAuthUrl) {
    try {
      return new URL(env.betterAuthUrl).origin
    } catch {
      // Fall back to the request URL if config is malformed.
    }
  }

  return new URL(requestUrl).origin
}

export function buildPublicUrl(requestUrl: string, pathAndSearch: string): string {
  return new URL(pathAndSearch, getPublicOrigin(requestUrl)).toString()
}
