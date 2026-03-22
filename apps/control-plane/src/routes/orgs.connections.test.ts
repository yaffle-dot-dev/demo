import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { eq } from "drizzle-orm"

import { db } from "../lib/db.ts"
import { connections, organizations } from "../db/schema.ts"
import { orgsRoute } from "./orgs.ts"
import { cleanupTestData, createTestContext, type TestContext } from "../test-utils/auth.ts"

const app = new Hono()
app.route("/api/orgs", orgsRoute)

let adminCtx: TestContext
let viewerCtx: TestContext

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(adminCtx.headers)
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  return app.request(path, {
    ...init,
    headers,
  })
}

async function reqAsViewer(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(viewerCtx.headers)
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  return app.request(path, {
    ...init,
    headers,
  })
}

beforeAll(async () => {
  adminCtx = await createTestContext({ orgSlug: "connections-test-org", role: "admin" })
  viewerCtx = await createTestContext({ orgSlug: "connections-test-org", role: "viewer" })

  await db
    .update(organizations)
    .set({
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
      iamRoleArn: "arn:aws:iam::123456789012:role/yaffle-org-broker-test",
    })
    .where(eq(organizations.id, adminCtx.org.id))
})

beforeEach(async () => {
  await db.delete(connections)
})

afterAll(async () => {
  await cleanupTestData()
})

describe("org connections routes", () => {
  test("creates an iam_role connection for an admin", async () => {
    const res = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "aws prod",
        providerType: "aws",
        credentialProviderType: "iam_role",
        environmentScope: ["production"],
        workspaceScope: ["infra/*"],
        roleArn: "arn:aws:iam::123456789012:role/yaffle-prod",
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.name).toBe("aws prod")
    expect(body.data.credentialProviderType).toBe("iam_role")
    expect(body.data.providerType).toBe("aws")
    expect(body.data.secretStore).toBeNull()
  })

  test("rejects create for non-admin membership", async () => {
    const res = await reqAsViewer("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "viewer attempt",
        providerType: "aws",
        credentialProviderType: "iam_role",
        environmentScope: [],
        workspaceScope: [],
        roleArn: "arn:aws:iam::123456789012:role/yaffle-prod",
      }),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe("FORBIDDEN")
  })

  test("rejects invalid env var key syntax", async () => {
    const res = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "bad env key",
        providerType: "generic",
        credentialProviderType: "envvar",
        environmentScope: [],
        workspaceScope: [],
        envVars: [{ key: "NOT-VALID", value: "secret" }],
      }),
    })

    expect(res.status).toBe(400)
  })

  test("infers provider type from env var credentials", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    const res = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "cloudflare inferred",
        providerType: "generic",
        credentialProviderType: "envvar",
        environmentScope: [],
        workspaceScope: [],
        envVars: [{ key: "CLOUDFLARE_API_TOKEN", value: "secret" }],
      }),
    })

    globalThis.fetch = originalFetch

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.providerType).toBe("cloudflare")
  })

  test("rejects invalid cloudflare api token", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ success: false }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    const res = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "cloudflare invalid",
        providerType: "cloudflare",
        credentialProviderType: "envvar",
        environmentScope: [],
        workspaceScope: [],
        envVars: [{ key: "CLOUDFLARE_API_TOKEN", value: "invalid" }],
      }),
    })

    globalThis.fetch = originalFetch

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("CLOUDFLARE_TOKEN_INVALID")
  })

  test("rejects invalid iam role arn syntax", async () => {
    const res = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "bad arn",
        providerType: "aws",
        credentialProviderType: "iam_role",
        environmentScope: [],
        workspaceScope: [],
        roleArn: "not-an-arn",
      }),
    })

    expect(res.status).toBe(400)
  })

  test("updates an existing iam_role connection", async () => {
    const createRes = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "aws staging",
        providerType: "aws",
        credentialProviderType: "iam_role",
        environmentScope: ["staging"],
        workspaceScope: ["infra/*"],
        roleArn: "arn:aws:iam::123456789012:role/yaffle-staging",
      }),
    })
    const created = await createRes.json()

    const updateRes = await req(`/api/orgs/connections-test-org/connections/${created.data.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "aws staging updated",
        providerType: "aws",
        credentialProviderType: "iam_role",
        environmentScope: ["staging", "production"],
        workspaceScope: ["infra/*"],
        roleArn: "arn:aws:iam::123456789012:role/yaffle-staging-v2",
      }),
    })

    expect(updateRes.status).toBe(200)
    const body = await updateRes.json()
    expect(body.data.name).toBe("aws staging updated")
    expect(body.data.secretArn).toContain("iam-role:arn:aws:iam::123456789012:role/yaffle-staging-v2")
  })

  test("rejects changing credential provider type in place", async () => {
    const createRes = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "aws immutable",
        providerType: "aws",
        credentialProviderType: "iam_role",
        environmentScope: ["production"],
        workspaceScope: ["infra/*"],
        roleArn: "arn:aws:iam::123456789012:role/yaffle-prod",
      }),
    })
    const created = await createRes.json()

    const res = await req(`/api/orgs/connections-test-org/connections/${created.data.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "aws immutable",
        providerType: "aws",
        credentialProviderType: "envvar",
        environmentScope: ["production"],
        workspaceScope: ["infra/*"],
        envVars: [{ key: "AWS_ACCESS_KEY_ID", value: "example" }],
      }),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe("CONNECTION_PROVIDER_TYPE_IMMUTABLE")
  })

  test("deletes an existing connection", async () => {
    const createRes = await req("/api/orgs/connections-test-org/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "aws delete",
        providerType: "aws",
        credentialProviderType: "iam_role",
        environmentScope: [],
        workspaceScope: [],
        roleArn: "arn:aws:iam::123456789012:role/yaffle-delete",
      }),
    })
    const created = await createRes.json()

    const res = await req(`/api/orgs/connections-test-org/connections/${created.data.id}`, {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.success).toBe(true)
  })

})
