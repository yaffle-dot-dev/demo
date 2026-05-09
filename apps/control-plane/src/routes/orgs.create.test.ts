import { afterEach, beforeEach, describe, expect, test } from "@yaffle/test"
import { Hono } from "hono"

import { cleanupTestData, createTestContext, type TestContext } from "../test-utils/auth.ts"
import { orgsRoute } from "./orgs.ts"

const app = new Hono()
app.route("/api/orgs", orgsRoute)

let authCtx: TestContext

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(authCtx.headers)
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  return app.request(path, {
    ...init,
    headers,
  })
}

beforeEach(async () => {
  authCtx = await createTestContext({ orgSlug: `org-create-${crypto.randomUUID().slice(0, 8)}` })
})

afterEach(async () => {
  await cleanupTestData()
})

describe("org creation", () => {
  test("allows top-level slugs like new once system routes move under /_/", async () => {
    const res = await req("/api/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "New Org",
        slug: "new",
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { slug: string } }
    expect(body.data.slug).toBe("new")
  })

  test("allows non-reserved slugs", async () => {
    const res = await req("/api/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Okay Org",
        slug: `okay-${crypto.randomUUID().slice(0, 8)}`,
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { slug: string } }
    expect(body.data.slug).toContain("okay-")
  })
})
