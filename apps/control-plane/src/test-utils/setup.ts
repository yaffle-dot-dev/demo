import { migrate } from "drizzle-orm/postgres-js/migrator"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

if (process.env.YAFFLE_SKIP_TEST_DB_SETUP === "true") {
  if (!process.env.BETTER_AUTH_URL) {
    process.env.BETTER_AUTH_URL = "https://yaffle.local:6969"
  }

  if (!process.env.TRUSTED_ORIGINS) {
    process.env.TRUSTED_ORIGINS = "https://yaffle.local:6969,http://yaffle.local:5173,http://yaffle.local:3000"
  }

  if (!process.env.BETTER_AUTH_SECRET) {
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret"
  }

  if (!process.env.YAFFLE_TF_BINARY) {
    process.env.YAFFLE_TF_BINARY = "tofu"
  }

  console.log("[test-setup] Skipping database setup")
} else {

/**
 * Test setup - runs before all tests via bunfig.toml preload.
 *
 * CRITICAL: Tests must use a separate database to avoid corrupting dev data.
 * This file ensures DATABASE_URL points to the test database.
 */

const TEST_DB_NAME = "yaffle_test"
const DEV_DB_NAME = "yaffle_dev"

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`
}

function buildAdminDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  url.pathname = "/postgres"
  return url.toString()
}

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const targetUrl = new URL(databaseUrl)
  const dbName = targetUrl.pathname.replace(/^\//, "")

  if (!dbName) {
    throw new Error("DATABASE_URL must include a database name")
  }

  const adminClient = postgres(buildAdminDatabaseUrl(databaseUrl), {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  })

  try {
    const result = await adminClient<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1
        FROM pg_database
        WHERE datname = ${dbName}
      ) AS exists
    `

    if (!result[0]?.exists) {
      console.log(`[test-setup] Creating missing test database: ${dbName}`)
      await adminClient.unsafe(`CREATE DATABASE ${quoteIdentifier(dbName)}`)
    }
  } finally {
    await adminClient.end()
  }
}

if (!process.env.BETTER_AUTH_URL) {
  process.env.BETTER_AUTH_URL = "https://yaffle.local:6969"
}

if (!process.env.TRUSTED_ORIGINS) {
  process.env.TRUSTED_ORIGINS = "https://yaffle.local:6969,http://yaffle.local:5173,http://yaffle.local:3000"
}

if (!process.env.BETTER_AUTH_SECRET) {
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret"
}

if (!process.env.YAFFLE_TF_BINARY) {
  process.env.YAFFLE_TF_BINARY = "tofu"
}

// Get current DATABASE_URL or use default
const currentUrl = process.env.DATABASE_URL ?? `postgresql://yaffle@localhost:5432/${DEV_DB_NAME}`

// Safety check: refuse to run tests against the dev database
if (currentUrl.includes(DEV_DB_NAME) || (!currentUrl.includes(TEST_DB_NAME) && !currentUrl.includes("_test"))) {
  // Override to use test database
  const testUrl = currentUrl.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`)
  process.env.DATABASE_URL = testUrl
  console.log(`[test-setup] Redirected DATABASE_URL to test database: ${TEST_DB_NAME}`)
}

// Double-check we're not using dev database
const finalUrl = process.env.DATABASE_URL!
if (finalUrl.includes(DEV_DB_NAME)) {
  throw new Error(
    `FATAL: Tests would run against dev database (${DEV_DB_NAME}). ` +
    `Set DATABASE_URL to use ${TEST_DB_NAME} or another test database.\n` +
    `Create the test database with: createdb ${TEST_DB_NAME}\n` +
    `Run migrations: DATABASE_URL=postgresql://yaffle@localhost:5432/${TEST_DB_NAME} bun run db:migrate`
  )
}

console.log(`[test-setup] Using database: ${finalUrl.replace(/\/\/[^@]+@/, "//***@")}`)

await ensureDatabaseExists(finalUrl)

const testDbClient = postgres(finalUrl, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
})

await migrate(drizzle(testDbClient), {
  migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
})

await testDbClient.end()

// Import lazily after DATABASE_URL has been forced to a test DB.
// This module imports the shared db singleton at module-load time.
const { ensureDefaultProviderCredentialSignatures } = await import(
  "../db/queries/provider-credential-signatures.ts"
)

await ensureDefaultProviderCredentialSignatures()
}
