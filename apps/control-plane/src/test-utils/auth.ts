/**
 * Test utilities for authentication.
 *
 * These helpers set up users, orgs, and memberships for tests,
 * and provide headers for dev-mode authentication.
 *
 * Usage:
 *   import { createTestContext, withTestAuth } from "../test-utils/auth.ts"
 *
 *   const ctx = await createTestContext()
 *   const res = await app.request("/api/previews?org=test-org", {
 *     headers: ctx.headers,
 *   })
 */

import { db } from "../lib/db.ts"
import { user, organizations, orgMemberships } from "../db/schema.ts"
import { eq, and, sql } from "drizzle-orm"

// Set auth mode to dev for tests (must be done before importing routes)
process.env.YAFFLE_AUTH_MODE = "dev"

export interface TestUser {
  id: string
  email: string
  name: string
}

export interface TestOrg {
  id: string
  slug: string
  name: string
}

export interface TestContext {
  user: TestUser
  org: TestOrg
  role: string
  headers: Headers
}

let testCounter = 0

/**
 * Generate a unique test ID to avoid collisions between parallel tests.
 */
function uniqueId(prefix: string): string {
  testCounter++
  return `${prefix}-${Date.now()}-${testCounter}`
}

/**
 * Create a test user in the database.
 */
export async function createTestUser(overrides: Partial<TestUser> = {}): Promise<TestUser> {
  const id = overrides.id ?? uniqueId("test-user")
  const email = overrides.email ?? `${id}@test.yaffle.dev`
  const name = overrides.name ?? `Test User ${id}`

  // Check if user exists
  const existing = await db.select().from(user).where(eq(user.id, id)).limit(1)
  if (existing.length > 0) {
    return { id, email: existing[0].email, name: existing[0].name ?? name }
  }

  await db.insert(user).values({
    id,
    email,
    name,
    emailVerified: true,
  })

  return { id, email, name }
}

/**
 * Create a test organization in the database.
 */
export async function createTestOrg(overrides: Partial<Omit<TestOrg, "id">> = {}): Promise<TestOrg> {
  const slug = overrides.slug ?? uniqueId("test-org")
  const name = overrides.name ?? `Test Org ${slug}`

  // Check if org exists
  const existing = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1)
  if (existing.length > 0) {
    return { id: existing[0].id, slug: existing[0].slug, name: existing[0].name }
  }

  // Let the database generate the UUID
  const rows = await db
    .insert(organizations)
    .values({
      slug,
      name,
      stateBucket: "test-bucket",
    })
    .returning()

  return { id: rows[0].id, slug: rows[0].slug, name: rows[0].name }
}

/**
 * Add a user to an organization with a specific role.
 */
export async function addMembership(
  orgId: string,
  userId: string,
  role: "viewer" | "approver" | "admin" = "admin",
): Promise<void> {
  // Check if membership exists
  const existing = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1)

  if (existing.length > 0) {
    // Update role if different
    if (existing[0].role !== role) {
      await db
        .update(orgMemberships)
        .set({ role })
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    }
    return
  }

  await db.insert(orgMemberships).values({
    orgId,
    userId,
    role,
    source: "manual",
  })
}

/**
 * Create headers for dev-mode authentication.
 */
export function authHeaders(ctx: {
  userId: string
  email: string
  name?: string
  orgId: string
  role: string
}): Headers {
  const headers = new Headers()
  headers.set("x-yaffle-user-id", ctx.userId)
  headers.set("x-yaffle-user-email", ctx.email)
  if (ctx.name) {
    headers.set("x-yaffle-user-name", ctx.name)
  }
  headers.set("x-yaffle-org-id", ctx.orgId)
  headers.set("x-yaffle-role", ctx.role)
  return headers
}

/**
 * Create a full test context with user, org, membership, and auth headers.
 * This is the main helper for most tests.
 */
export async function createTestContext(options: {
  role?: "viewer" | "approver" | "admin"
  orgSlug?: string
} = {}): Promise<TestContext> {
  const role = options.role ?? "admin"

  const testUser = await createTestUser()
  const testOrg = await createTestOrg({ slug: options.orgSlug })
  await addMembership(testOrg.id, testUser.id, role)

  const headers = authHeaders({
    userId: testUser.id,
    email: testUser.email,
    name: testUser.name,
    orgId: testOrg.id,
    role,
  })

  return {
    user: testUser,
    org: testOrg,
    role,
    headers,
  }
}

/**
 * Clean up test data. Call this in afterAll or afterEach.
 * Uses TRUNCATE CASCADE to handle foreign key constraints.
 *
 * SAFETY: This only runs against the test database (enforced by setup.ts).
 */
export async function cleanupTestData(): Promise<void> {
  // Safety check - refuse to truncate if not using test database
  const dbUrl = process.env.DATABASE_URL ?? ""
  if (!dbUrl.includes("_test")) {
    throw new Error(
      `FATAL: cleanupTestData() called but DATABASE_URL doesn't contain '_test'. ` +
      `Refusing to truncate tables. Current URL: ${dbUrl.replace(/\/\/[^@]+@/, "//***@")}`
    )
  }

  // Use raw SQL for TRUNCATE CASCADE since Drizzle doesn't support it directly
  await db.execute(sql`TRUNCATE TABLE principals CASCADE`)
  await db.execute(sql`TRUNCATE TABLE org_memberships CASCADE`)
  await db.execute(sql`TRUNCATE TABLE organizations CASCADE`)
  // Don't truncate users - they might be referenced by other tables
}
