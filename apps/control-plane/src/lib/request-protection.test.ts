import { beforeEach, describe, expect, test } from "@yaffle/test"
import { Hono } from "hono"

import {
  enforceRateLimit,
  readRequestBodyBytes,
  RequestBodyTooLargeError,
  resetRateLimitStore,
} from "./request-protection.ts"

beforeEach(() => {
  resetRateLimitStore()
})

describe("enforceRateLimit", () => {
  test("limits repeated requests from the same client", async () => {
    const app = new Hono()

    app.get("/limited", (c) => {
      const response = enforceRateLimit(c, {
        bucket: "test",
        limit: 2,
        windowMs: 60_000,
      })

      return response ?? c.json({ ok: true })
    })

    const makeRequest = () =>
      new Request("http://localhost/limited", {
        headers: {
          "x-forwarded-for": "203.0.113.10",
        },
      })

    expect((await app.fetch(makeRequest())).status).toBe(200)
    expect((await app.fetch(makeRequest())).status).toBe(200)

    const limited = await app.fetch(makeRequest())
    expect(limited.status).toBe(429)
    expect(limited.headers.get("Retry-After")).toBeTruthy()
  })
})

describe("readRequestBodyBytes", () => {
  test("rejects oversized request bodies from content-length", async () => {
    const request = new Request("http://localhost/upload", {
      method: "PUT",
      headers: {
        "content-length": "11",
      },
      body: "hello",
    })

    await expect(readRequestBodyBytes(request, 10)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })

  test("rejects oversized streamed request bodies", async () => {
    const request = new Request("http://localhost/upload", {
      method: "PUT",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"))
          controller.enqueue(new TextEncoder().encode(" world"))
          controller.close()
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" })

    await expect(readRequestBodyBytes(request, 10)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })
})
