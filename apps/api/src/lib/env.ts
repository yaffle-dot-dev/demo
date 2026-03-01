import { readFileSync } from "node:fs"

export interface AppEnv {
  githubAppId: string
  githubAppPrivateKey: string
  githubWebhookSecret: string
  databaseUrl: string
}

function loadPrivateKey(): string {
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY
  if (!keyPath) return ""
  // secretspec gives us a file path (as_path = true)
  try {
    return readFileSync(keyPath, "utf-8")
  } catch {
    // Fall back to treating the value as the key itself (for tests)
    return keyPath
  }
}

export function getEnv(): AppEnv {
  return {
    githubAppId: process.env.GITHUB_APP_ID ?? "",
    githubAppPrivateKey: loadPrivateKey(),
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://yaffle@localhost:5432/yaffle_dev",
  }
}
