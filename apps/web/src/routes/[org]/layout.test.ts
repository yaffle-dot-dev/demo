import { describe, expect, test } from "bun:test"

import { load } from "./+layout.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("[org] layout access guard", () => {
  test("allows access when the org exists in the caller org list", async () => {
    const result = await load({
      fetch: async () => jsonResponse({
        data: [{ slug: "yaffle-dot-dev" }],
      }),
      params: { org: "yaffle-dot-dev" },
    } as never)

    expect(result).toEqual({})
  })

  test("throws 404 when the org slug is not in the caller org list", async () => {
    await expect(load({
      fetch: async () => jsonResponse({
        data: [{ slug: "yaffle-dot-dev" }],
      }),
      params: { org: "fuuuck" },
    } as never)).rejects.toMatchObject({
      status: 404,
      body: {
        message: "Organization fuuuck not found",
      },
    })
  })

  test("fails closed when the org list request itself fails", async () => {
    await expect(load({
      fetch: async () => jsonResponse({ error: { message: "backend unavailable" } }, 503),
      params: { org: "yaffle-dot-dev" },
    } as never)).rejects.toMatchObject({
      status: 503,
      body: {
        message: "Failed to validate organization access",
      },
    })
  })
})
