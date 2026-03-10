/**
 * Test setup - runs before all tests via bunfig.toml preload.
 *
 * CRITICAL: Tests must use a separate database to avoid corrupting dev data.
 * This file ensures DATABASE_URL points to the test database.
 */

const TEST_DB_NAME = "yaffle_test"
const DEV_DB_NAME = "yaffle_dev"

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
