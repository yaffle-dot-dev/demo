import { migrate } from "drizzle-orm/postgres-js/migrator"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

/**
 * Test setup - runs before all tests via bunfig.toml preload.
 *
 * CRITICAL: Tests must use a separate database to avoid corrupting dev data.
 * This file ensures DATABASE_URL points to the test database.
 */

const TEST_DB_NAME = "yaffle_test"
const DEV_DB_NAME = "yaffle_dev"

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
