import { readFileSync } from "node:fs"

export interface AppEnv {
  githubAppId: string
  githubAppPrivateKey: string
  githubWebhookSecret: string
  databaseUrl: string
  /** OTEL_EXPORTER_OTLP_ENDPOINT -- e.g. https://api.axiom.co */
  otelEndpoint: string
  /** OTEL_EXPORTER_OTLP_HEADERS -- e.g. "Authorization=Bearer xxx,X-Axiom-Dataset=yaffle" */
  otelHeaders: string
  /** YAFFLE_ENV -- deployment environment name (development, staging, production) */
  yaffleEnv: string
  /** YAFFLE_AUTH_MODE -- dev | required (default: required) */
  authMode: "dev" | "required"
  /** BETTER_AUTH_SECRET -- 32+ char secret for BetterAuth encryption */
  betterAuthSecret: string
  /** BETTER_AUTH_URL -- Base URL for BetterAuth (e.g., https://api.yaffle.dev) */
  betterAuthUrl: string
  /** TRUSTED_ORIGINS -- Comma-separated list of trusted origins for OAuth callbacks */
  trustedOrigins: string
  /** GITHUB_OAUTH_CLIENT_ID -- GitHub OAuth app client ID */
  githubOauthClientId: string
  /** GITHUB_OAUTH_CLIENT_SECRET -- GitHub OAuth app client secret */
  githubOauthClientSecret: string
}

/**
 * Normalize a PEM key that may have been flattened to a single line.
 * Some secret injectors/store backends can't preserve multiline PEM values
 * and provide something like:
 *   "-----BEGIN RSA PRIVATE KEY----- MIIEp... -----END RSA PRIVATE KEY-----"
 * We need to restore the proper PEM line breaks.
 */
function normalizePem(raw: string): string {
  const trimmed = raw.trim()

  // Already has proper newlines -- return as-is
  if (trimmed.includes("\n")) return trimmed

  // Single-line PEM: extract header, base64 body, footer and reformat
  const match = trimmed.match(
    /^(-----BEGIN [A-Z ]+-----)\s+(.+?)\s+(-----END [A-Z ]+-----)-*$/,
  )
  if (!match) return trimmed

  const [, header, body, footer] = match

  // Split the base64 body into 64-char lines (PEM standard)
  const bodyNoSpaces = body.replace(/\s+/g, "")
  const lines: string[] = []
  for (let i = 0; i < bodyNoSpaces.length; i += 64) {
    lines.push(bodyNoSpaces.slice(i, i + 64))
  }

  return `${header}\n${lines.join("\n")}\n${footer}`
}

function loadPrivateKey(): string {
  const keyEnv = process.env.GITHUB_APP_PRIVATE_KEY
  if (!keyEnv) return ""

  // Some secret tools may set env vars to a file path containing the PEM.
  try {
    const contents = readFileSync(keyEnv, "utf-8").trim()
    if (contents.includes("-----BEGIN")) {
      const pem = normalizePem(contents)
      console.log(`loaded private key from file: ${keyEnv} (${pem.split("\n").length} lines)`)
      return pem
    }
    console.log(`file ${keyEnv} read but no PEM header found, using contents as key`)
    return contents
  } catch {
    // Not a file path -- treat the value as the key itself
    if (keyEnv.includes("-----BEGIN")) {
      const pem = normalizePem(keyEnv)
      console.log(`using GITHUB_APP_PRIVATE_KEY env var directly as PEM key`)
      return pem
    }
    console.warn(`GITHUB_APP_PRIVATE_KEY is not a valid file path or PEM key`)
    return keyEnv
  }
}

export function getEnv(): AppEnv {
  return {
    githubAppId: process.env.GITHUB_APP_ID ?? "",
    githubAppPrivateKey: loadPrivateKey(),
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://yaffle@localhost:5432/yaffle_dev",
    otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
    otelHeaders: process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "",
    yaffleEnv: process.env.YAFFLE_ENV ?? "development",
    authMode: (process.env.YAFFLE_AUTH_MODE === "dev" ? "dev" : "required") as "dev" | "required",
    betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? "",
    betterAuthUrl: process.env.BETTER_AUTH_URL ?? "",
    trustedOrigins: process.env.TRUSTED_ORIGINS ?? "",
    githubOauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    githubOauthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
  }
}
