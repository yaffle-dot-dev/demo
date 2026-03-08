import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createHash } from "node:crypto"

import { tfcRoute } from "./index.ts"
import { wellKnownRoute } from "../well-known.ts"
import { generateRunToken } from "../../lib/run-token.ts"
import {
  createApiToken,
  generateToken,
  deleteApiTokensByUserId,
} from "../../db/queries/api-tokens.ts"
import {
  deleteWorkspace,
  findWorkspaceByName,
} from "../../db/queries/workspaces.ts"
import { findOrgBySlug, createOrg } from "../../db/queries/organizations.ts"
import { ensureMembership } from "../../db/queries/users.ts"
import { db } from "../../lib/db.ts"
import { user } from "../../db/schema.ts"
import { eq } from "drizzle-orm"

/**
 * Integration tests for the TFC-compatible state backend.
 *
 * These tests exercise the full API surface:
 * - Service discovery (/.well-known/terraform.json)
 * - Workspace CRUD and locking
 * - State version upload/download
 * - Authentication (user tokens and run tokens)
 *
 * Prerequisites:
 * - Database must be running and migrated:
 *   DATABASE_URL=postgresql://yaffle@localhost:5432/yaffle_test bun run db:migrate
 * - BETTER_AUTH_SECRET must be set (for JWT signing):
 *   BETTER_AUTH_SECRET=test-secret-at-least-32-characters-long
 *
 * Run with:
 *   DATABASE_URL=postgresql://yaffle@localhost:5432/yaffle_test \
 *   BETTER_AUTH_SECRET=test-secret-at-least-32-characters-long \
 *   bun test src/routes/tfc/tfc.integration.test.ts
 */

// Test app with TFC routes mounted
const app = new Hono()
app.route("/.well-known", wellKnownRoute)
app.route("/tfc", tfcRoute)

// Test fixtures
const TEST_ORG_SLUG = "tfc-test-org"
const TEST_USER_ID = "test-user-tfc-integration"
const TEST_WORKSPACE_NAME = "tfc-integration-test-workspace"

let testOrgId: string
let testUserToken: string
let testWorkspaceId: string | null = null

/**
 * Helper to make authenticated requests with a bearer token.
 */
function authRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
  }
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

/**
 * Helper to compute MD5 hash of content (hex string).
 */
function md5(content: string | Uint8Array): string {
  const data = typeof content === "string" ? content : content
  return createHash("md5").update(data).digest("hex")
}

// =============================================================================
// Test Setup and Teardown
// =============================================================================

beforeAll(async () => {
  // Ensure test user exists (find or create)
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1)
  if (existingUser.length === 0) {
    await db.insert(user).values({
      id: TEST_USER_ID,
      name: "TFC Test User",
      email: "tfc-test@example.com",
      emailVerified: true,
    })
  }

  // Ensure test org exists (find or create)
  let org = await findOrgBySlug(TEST_ORG_SLUG)
  if (!org) {
    org = await createOrg({
      name: "TFC Test Org",
      slug: TEST_ORG_SLUG,
    })
  }
  testOrgId = org.id

  // Ensure test user is a member of the org (required for registry access)
  await ensureMembership({
    orgId: testOrgId,
    userId: TEST_USER_ID,
    role: "admin",
    source: "manual",
  })

  // Clean up any existing test tokens first
  await deleteApiTokensByUserId(TEST_USER_ID)

  // Create a test API token for the test user
  const { token, hash } = generateToken()
  await createApiToken({
    userId: TEST_USER_ID,
    tokenHash: hash,
    description: "TFC integration test token",
  })
  testUserToken = token
})

afterAll(async () => {
  // Clean up test workspace if it exists
  if (testWorkspaceId) {
    await deleteWorkspace(testWorkspaceId)
  }

  // Clean up test tokens
  await deleteApiTokensByUserId(TEST_USER_ID)
})

beforeEach(async () => {
  // Clean up any leftover test workspace from failed tests
  const existing = await findWorkspaceByName(testOrgId, TEST_WORKSPACE_NAME)
  if (existing) {
    await deleteWorkspace(existing.id)
  }
  testWorkspaceId = null
})

// =============================================================================
// Service Discovery Tests
// =============================================================================

describe("Service Discovery", () => {
  test("GET /.well-known/terraform.json returns TFC endpoints", async () => {
    const res = await app.fetch(new Request("http://localhost/.well-known/terraform.json"))

    expect(res.status).toBe(200)
    const body = await res.json()

    // Verify required fields for terraform login and cloud block
    expect(body["tfe.v2"]).toBe("/tfc/api/v2/")
    expect(body["login.v1"]).toBeDefined()
    expect(body["login.v1"].client).toBe("terraform-cli")
    expect(body["login.v1"].grant_types).toContain("authz_code")
    expect(body["login.v1"].authz).toBe("/tfc/oauth/authorize")
    expect(body["login.v1"].token).toBe("/tfc/oauth/token")
  })

  test("GET /tfc/api/v2/ping returns TFP-API-Version header >= 2.5", async () => {
    const res = await app.fetch(new Request("http://localhost/tfc/api/v2/ping"))

    expect(res.status).toBe(200)

    // Terraform requires TFP-API-Version >= 2.5 for the cloud backend
    const apiVersion = res.headers.get("TFP-API-Version")
    expect(apiVersion).toBeDefined()

    // Parse and verify version is >= 2.5
    const [major, minor] = apiVersion!.split(".").map(Number)
    expect(major).toBeGreaterThanOrEqual(2)
    if (major === 2) {
      expect(minor).toBeGreaterThanOrEqual(5)
    }
  })
})

// =============================================================================
// Authentication Tests
// =============================================================================

describe("Authentication", () => {
  test("rejects requests without Authorization header", async () => {
    const res = await app.fetch(
      new Request(`http://localhost/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`),
    )

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.errors[0].status).toBe("401")
  })

  test("rejects requests with invalid token", async () => {
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        "invalid-token-12345",
      ),
    )

    expect(res.status).toBe(401)
  })

  test("accepts requests with valid user token", async () => {
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
  })

  test("accepts requests with valid run token (JWT)", async () => {
    // First create a workspace to get an ID
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: {
              name: TEST_WORKSPACE_NAME,
              environment: "preview",
            },
          },
        },
      ),
    )
    expect(createRes.status).toBe(201)
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Generate a run token for this workspace
    const runToken = await generateRunToken(
      "test-run-123",
      testWorkspaceId!,
      testOrgId,
    )

    // Use the run token to access the workspace
    const res = await app.fetch(
      authRequest("GET", `/tfc/api/v2/workspaces/${testWorkspaceId}`, runToken),
    )

    expect(res.status).toBe(200)
  })
})

// =============================================================================
// Workspace CRUD Tests
// =============================================================================

describe("Workspace CRUD", () => {
  test("creates a workspace", async () => {
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: {
              name: TEST_WORKSPACE_NAME,
              environment: "preview",
              "pr-number": 42,
              "workspace-path": "infra",
            },
          },
        },
      ),
    )

    expect(res.status).toBe(201)
    const body = await res.json()

    expect(body.data.type).toBe("workspaces")
    expect(body.data.attributes.name).toBe(TEST_WORKSPACE_NAME)
    expect(body.data.attributes.environment).toBe("preview")
    expect(body.data.attributes.locked).toBe(false)

    testWorkspaceId = body.data.id
  })

  test("rejects duplicate workspace name", async () => {
    // Create first workspace
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )

    // Try to create duplicate
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )

    expect(res.status).toBe(409)
  })

  test("gets workspace by name", async () => {
    // Create workspace first
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Get by name
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces/${TEST_WORKSPACE_NAME}`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(testWorkspaceId)
    expect(body.data.attributes.name).toBe(TEST_WORKSPACE_NAME)
  })

  test("workspace response includes all required TFC fields for cloud backend", async () => {
    // Create workspace first
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Get the workspace
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces/${TEST_WORKSPACE_NAME}`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    const attrs = body.data.attributes

    // Verify execution-mode is set to "local" for Yaffle
    expect(attrs["execution-mode"]).toBe("local")

    // Verify operations is enabled
    expect(attrs.operations).toBe(true)

    // Verify permissions object exists with required fields
    expect(attrs.permissions).toBeDefined()
    expect(attrs.permissions["can-queue-run"]).toBe(true)
    expect(attrs.permissions["can-queue-apply"]).toBe(true)
    expect(attrs.permissions["can-destroy"]).toBe(true)
    expect(attrs.permissions["can-lock"]).toBe(true)
    expect(attrs.permissions["can-unlock"]).toBe(true)

    // Verify other required fields
    expect(attrs["terraform-version"]).toBeDefined()
    expect(attrs["speculative-enabled"]).toBeDefined()
  })

  test("workspace response JSON matches go-tfe expected structure", async () => {
    // This test verifies the exact JSON structure that go-tfe/jsonapi expects
    // Create workspace first
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Get the raw response text to verify JSON structure
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces/${TEST_WORKSPACE_NAME}`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    
    // Check Content-Type header
    const contentType = res.headers.get("Content-Type")
    expect(contentType).toBe("application/vnd.api+json")
    
    // Check TFP-API-Version header
    const apiVersion = res.headers.get("TFP-API-Version")
    expect(apiVersion).toBeDefined()
    
    const body = await res.json()
    
    // Verify top-level structure
    expect(body).toHaveProperty("data")
    expect(body.data).toHaveProperty("id")
    expect(body.data).toHaveProperty("type", "workspaces")
    expect(body.data).toHaveProperty("attributes")
    
    // Verify attributes structure (these are what go-tfe parses)
    const attrs = body.data.attributes
    
    // execution-mode must be a string at the attribute level
    expect(typeof attrs["execution-mode"]).toBe("string")
    expect(attrs["execution-mode"]).toBe("local")
    
    // operations must be a boolean
    expect(typeof attrs.operations).toBe("boolean")
    expect(attrs.operations).toBe(true)
    
    // permissions must be an object (go-tfe will recursively unmarshal this)
    expect(typeof attrs.permissions).toBe("object")
    expect(attrs.permissions).not.toBeNull()
    
    // Verify permissions nested structure
    expect(typeof attrs.permissions["can-queue-run"]).toBe("boolean")
    expect(typeof attrs.permissions["can-destroy"]).toBe("boolean")
    expect(typeof attrs.permissions["can-lock"]).toBe("boolean")
    expect(typeof attrs.permissions["can-unlock"]).toBe("boolean")
    expect(typeof attrs.permissions["can-force-unlock"]).toBe("boolean")
    expect(typeof attrs.permissions["can-queue-apply"]).toBe("boolean")
    
    // Verify relationships exist (required by go-tfe)
    expect(body.data).toHaveProperty("relationships")
    expect(body.data.relationships).toHaveProperty("organization")
    expect(body.data.relationships.organization).toHaveProperty("data")
    expect(body.data.relationships.organization.data).toHaveProperty("type", "organizations")
  })

  test("gets workspace by ID", async () => {
    // Create workspace first
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Get by ID
    const res = await app.fetch(
      authRequest("GET", `/tfc/api/v2/workspaces/${testWorkspaceId}`, testUserToken),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(testWorkspaceId)
  })

  test("lists workspaces in organization", async () => {
    // Create a workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // List workspaces
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeInstanceOf(Array)
    expect(body.data.some((ws: { id: string }) => ws.id === testWorkspaceId)).toBe(true)
  })
})

// =============================================================================
// Workspace Locking Tests
// =============================================================================

describe("Workspace Locking", () => {
  test("locks a workspace with user token", async () => {
    // Create workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock workspace
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
        { reason: "Running terraform apply" },
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.attributes.locked).toBe(true)
    expect(body.data.attributes["locked-by"]).toContain("user:")
  })

  test("locks a workspace with run token", async () => {
    // Create workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Generate run token
    const runToken = await generateRunToken("test-run-lock", testWorkspaceId!, testOrgId)

    // Lock with run token
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        runToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.attributes.locked).toBe(true)
    expect(body.data.attributes["locked-by"]).toBe("run:test-run-lock")
  })

  test("rejects lock on already locked workspace", async () => {
    // Create and lock workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // First lock
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    // Second lock attempt
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.errors[0].title).toBe("Workspace is locked")
  })

  test("unlocks a workspace (same owner)", async () => {
    // Create workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    // Unlock
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/unlock`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.attributes.locked).toBe(false)
  })

  test("rejects unlock from different owner", async () => {
    // Create workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock with run token
    const runToken = await generateRunToken("run-owner", testWorkspaceId!, testOrgId)
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        runToken,
      ),
    )

    // Try to unlock with different run token
    const otherRunToken = await generateRunToken("other-run", testWorkspaceId!, testOrgId)
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/unlock`,
        otherRunToken,
      ),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.errors[0].title).toBe("Cannot unlock workspace")
  })

  test("force-unlocks a workspace (requires user token)", async () => {
    // Create workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock with run token
    const runToken = await generateRunToken("stuck-run", testWorkspaceId!, testOrgId)
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        runToken,
      ),
    )

    // Force unlock with user token
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/force-unlock`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.attributes.locked).toBe(false)
  })
})

// =============================================================================
// State Version Tests
// =============================================================================

describe("State Versions", () => {
  const testState = JSON.stringify({
    version: 4,
    terraform_version: "1.7.0",
    serial: 1,
    lineage: "12345678-1234-1234-1234-123456789012",
    outputs: {
      example: { value: "hello", type: "string" },
    },
    resources: [],
  })

  test("creates state version (two-phase upload)", async () => {
    // Create workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock workspace (required for state upload)
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    // Phase 1: Create state version (get upload URL)
    const stateMd5 = md5(testState)
    const createSvRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
              md5: stateMd5,
              lineage: "12345678-1234-1234-1234-123456789012",
            },
          },
        },
      ),
    )

    expect(createSvRes.status).toBe(201)
    const svBody = await createSvRes.json()
    expect(svBody.data.type).toBe("state-versions")
    expect(svBody.data.attributes.serial).toBe(1)
    expect(svBody.data.attributes.status).toBe("pending")
    expect(svBody.data.attributes["hosted-state-upload-url"]).toBeDefined()

    const stateVersionId = svBody.data.id
    const uploadUrl = svBody.data.attributes["hosted-state-upload-url"]
    // Extract path from full URL (https://host:port/path -> /path)
    const uploadPath = new URL(uploadUrl).pathname

    // Phase 2: Upload state content
    const uploadRes = await app.fetch(
      new Request(`http://localhost${uploadPath}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${testUserToken}`,
          "Content-Type": "application/json",
        },
        body: testState,
      }),
    )

    expect(uploadRes.status).toBe(200)

    // Verify state version is now finalized
    const getSvRes = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/state-versions/${stateVersionId}`,
        testUserToken,
      ),
    )

    expect(getSvRes.status).toBe(200)
    const finalizedSv = await getSvRes.json()
    expect(finalizedSv.data.attributes.status).toBe("finalized")
    expect(finalizedSv.data.attributes["hosted-state-download-url"]).toBeDefined()
  })

  test("rejects state upload when workspace not locked", async () => {
    // Create workspace (not locked)
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Try to create state version without locking
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
              md5: md5(testState),
            },
          },
        },
      ),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.errors[0].title).toBe("Workspace must be locked")
  })

  test("rejects state upload with wrong lock owner", async () => {
    // Create workspace
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock with user token
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    // Try to upload state with different run token
    const runToken = await generateRunToken("other-run", testWorkspaceId!, testOrgId)
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        runToken,
        {
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
              md5: md5(testState),
            },
          },
        },
      ),
    )

    expect(res.status).toBe(409)
  })

  test("rejects serial number going backwards", async () => {
    // Create workspace and lock
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    // Create first state version with serial 5
    const state5 = JSON.stringify({ ...JSON.parse(testState), serial: 5 })
    const sv5Res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: { serial: 5, md5: md5(state5) },
          },
        },
      ),
    )
    expect(sv5Res.status).toBe(201)
    const sv5Body = await sv5Res.json()

    // Upload to finalize
    const uploadPath5 = new URL(sv5Body.data.attributes["hosted-state-upload-url"]).pathname
    await app.fetch(
      new Request(`http://localhost${uploadPath5}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${testUserToken}`,
          "Content-Type": "application/json",
        },
        body: state5,
      }),
    )

    // Try to create state version with lower serial
    const res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: { serial: 3, md5: md5(testState) },
          },
        },
      ),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.errors[0].title).toBe("Serial number conflict")
  })

  test("gets current state version", async () => {
    // Create workspace, lock, and upload state
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    const stateMd5 = md5(testState)
    const svRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: { serial: 1, md5: stateMd5 },
          },
        },
      ),
    )
    const svBody = await svRes.json()
    const uploadPathCurrent = new URL(svBody.data.attributes["hosted-state-upload-url"]).pathname

    await app.fetch(
      new Request(`http://localhost${uploadPathCurrent}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${testUserToken}`,
          "Content-Type": "application/json",
        },
        body: testState,
      }),
    )

    // Get current state version
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/current-state-version`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.attributes.serial).toBe(1)
    expect(body.data.attributes.status).toBe("finalized")
  })

  test("downloads state content", async () => {
    // Create workspace, lock, and upload state
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: TEST_WORKSPACE_NAME },
          },
        },
      ),
    )
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    const stateMd5 = md5(testState)
    const svRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: { serial: 1, md5: stateMd5 },
          },
        },
      ),
    )
    const svBody = await svRes.json()
    const stateVersionId = svBody.data.id
    const uploadPathDownload = new URL(svBody.data.attributes["hosted-state-upload-url"]).pathname

    await app.fetch(
      new Request(`http://localhost${uploadPathDownload}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${testUserToken}`,
          "Content-Type": "application/json",
        },
        body: testState,
      }),
    )

    // Download state
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/api/v2/state-versions/${stateVersionId}/download`,
        testUserToken,
      ),
    )

    // May redirect or return content directly
    if (res.status === 302) {
      // Redirect to S3 presigned URL
      expect(res.headers.get("location")).toBeTruthy()
    } else {
      expect(res.status).toBe(200)
      const downloadedState = await res.text()
      expect(downloadedState).toBe(testState)
    }
  })
})

// =============================================================================
// Module Registry Tests
// =============================================================================

describe("Module Registry", () => {
  const testState = JSON.stringify({
    version: 4,
    terraform_version: "1.7.0",
    serial: 1,
    lineage: "12345678-1234-1234-1234-123456789012",
    outputs: {
      vpc_id: { value: "vpc-0123456789abcdef0", type: "string" },
      private_subnet_ids: { value: ["subnet-aaa", "subnet-bbb"], type: ["list", "string"] },
      is_production: { value: true, type: "bool" },
    },
    resources: [],
  })

  test("service discovery includes modules.v1", async () => {
    const res = await app.fetch(new Request("http://localhost/.well-known/terraform.json"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body["modules.v1"]).toBe("/tfc/registry/v1/modules/")
  })

  test("lists module versions for a workspace", async () => {
    // Create workspace with a workspace_path
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: {
              name: TEST_WORKSPACE_NAME,
              environment: "main",
              "workspace-path": "core-infrastructure/vpc",
            },
          },
        },
      ),
    )
    expect(createRes.status).toBe(201)
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock and upload state
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    const stateMd5 = md5(testState)
    const svRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
              md5: stateMd5,
              lineage: "12345678-1234-1234-1234-123456789012",
            },
          },
        },
      ),
    )
    const svBody = await svRes.json()
    const uploadPathReg = new URL(svBody.data.attributes["hosted-state-upload-url"]).pathname

    await app.fetch(
      new Request(`http://localhost${uploadPathReg}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${testUserToken}`,
          "Content-Type": "application/json",
        },
        body: testState,
      }),
    )

    // Now query the module registry
    // Module name is workspace path with / replaced by --
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/registry/v1/modules/${TEST_ORG_SLUG}/core-infrastructure--vpc/yaffle/versions`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modules).toBeDefined()
    expect(body.modules[0].versions).toHaveLength(1)
    expect(body.modules[0].versions[0].version).toBe("1.0.1")
  })

  test("returns 404 for non-existent module", async () => {
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/registry/v1/modules/${TEST_ORG_SLUG}/non-existent--module/yaffle/versions`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(404)
  })

  test("returns 404 for wrong provider", async () => {
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/registry/v1/modules/${TEST_ORG_SLUG}/some-module/aws/versions`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(404)
  })

  test("download returns X-Terraform-Get header", async () => {
    // Create workspace with a workspace_path
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: {
              name: TEST_WORKSPACE_NAME,
              environment: "main",
              "workspace-path": "infra/networking",
            },
          },
        },
      ),
    )
    expect(createRes.status).toBe(201)
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock and upload state
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    const stateMd5 = md5(testState)
    const svRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
              md5: stateMd5,
              lineage: "12345678-1234-1234-1234-123456789012",
            },
          },
        },
      ),
    )
    const svBody = await svRes.json()
    const uploadPathDl = new URL(svBody.data.attributes["hosted-state-upload-url"]).pathname

    await app.fetch(
      new Request(`http://localhost${uploadPathDl}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${testUserToken}`,
          "Content-Type": "application/json",
        },
        body: testState,
      }),
    )

    // Request module download
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/registry/v1/modules/${TEST_ORG_SLUG}/infra--networking/yaffle/1.0.1/download`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(204)
    expect(res.headers.get("X-Terraform-Get")).toBe(
      `/tfc/registry/v1/modules/${TEST_ORG_SLUG}/infra--networking/yaffle/1.0.1/archive.tar.gz`,
    )
  })

  test("archive returns valid tar.gz with generated module", async () => {
    // Create workspace with a workspace_path
    const createRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: {
              name: TEST_WORKSPACE_NAME,
              environment: "main",
              "workspace-path": "test/outputs",
            },
          },
        },
      ),
    )
    expect(createRes.status).toBe(201)
    const createBody = await createRes.json()
    testWorkspaceId = createBody.data.id

    // Lock and upload state
    await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/actions/lock`,
        testUserToken,
      ),
    )

    const stateMd5 = md5(testState)
    const svRes = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${testWorkspaceId}/state-versions`,
        testUserToken,
        {
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
              md5: stateMd5,
              lineage: "12345678-1234-1234-1234-123456789012",
            },
          },
        },
      ),
    )
    const svBody = await svRes.json()
    const uploadPathArch = new URL(svBody.data.attributes["hosted-state-upload-url"]).pathname

    await app.fetch(
      new Request(`http://localhost${uploadPathArch}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${testUserToken}`,
          "Content-Type": "application/json",
        },
        body: testState,
      }),
    )

    // Request module archive
    const res = await app.fetch(
      authRequest(
        "GET",
        `/tfc/registry/v1/modules/${TEST_ORG_SLUG}/test--outputs/yaffle/1.0.1/archive.tar.gz`,
        testUserToken,
      ),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/gzip")

    // Verify it's a valid gzip file (starts with magic bytes 1f 8b)
    const body = await res.arrayBuffer()
    const bytes = new Uint8Array(body)
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
  })
})

// =============================================================================
// Run Token Scope Tests
// =============================================================================

describe("Run Token Scopes", () => {
  test("run token can only access its workspace", async () => {
    // Create two workspaces
    const ws1Res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: `${TEST_WORKSPACE_NAME}-1` },
          },
        },
      ),
    )
    const ws1 = await ws1Res.json()
    const ws1Id = ws1.data.id

    const ws2Res = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/organizations/${TEST_ORG_SLUG}/workspaces`,
        testUserToken,
        {
          data: {
            type: "workspaces",
            attributes: { name: `${TEST_WORKSPACE_NAME}-2` },
          },
        },
      ),
    )
    const ws2 = await ws2Res.json()
    const ws2Id = ws2.data.id

    // Clean up at end
    testWorkspaceId = ws1Id

    // Generate run token for workspace 1
    const runToken = await generateRunToken("run-ws1", ws1Id, testOrgId)

    // Can access workspace 1
    const res1 = await app.fetch(
      authRequest("GET", `/tfc/api/v2/workspaces/${ws1Id}`, runToken),
    )
    expect(res1.status).toBe(200)

    // Cannot lock workspace 2
    const res2 = await app.fetch(
      authRequest(
        "POST",
        `/tfc/api/v2/workspaces/${ws2Id}/actions/lock`,
        runToken,
      ),
    )
    expect(res2.status).toBe(403)

    // Clean up workspace 2
    await deleteWorkspace(ws2Id)
  })
})
