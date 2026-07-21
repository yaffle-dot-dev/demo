import { afterEach, describe, expect, test } from "@yaffle/test"

import { RunnerApiClient } from "./api-client.ts"

const originalFetch = globalThis.fetch

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    return {}
  }
  return JSON.parse(body) as Record<string, unknown>
}

describe("RunnerApiClient completion payloads", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("includes full log output when completing a job", async () => {
    let body: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = parseRequestBody(init?.body)
      return new Response(JSON.stringify({ data: { success: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const client = new RunnerApiClient({
      apiUrl: "https://api.yaffle.dev",
      jobToken: "runner-token",
      jobId: "job-id",
    })

    await client.complete("run-id", {
      logOutput: "full formatted log",
      output: "raw output",
    })

    expect(body?.logOutput).toBe("full formatted log")
    expect(body?.status).toBe("completed")
  })

  test("includes full log output when failing a job", async () => {
    let body: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = parseRequestBody(init?.body)
      return new Response(JSON.stringify({ data: { success: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const client = new RunnerApiClient({
      apiUrl: "https://api.yaffle.dev",
      jobToken: "runner-token",
      jobId: "job-id",
    })

    await client.fail("run-id", "boom", { logOutput: "full formatted log" })

    expect(body?.logOutput).toBe("full formatted log")
    expect(body?.errorMessage).toBe("boom")
    expect(body?.status).toBe("failed")
  })

  test("uploads plan artifacts without allowing an overwrite", async () => {
    let headers: Headers | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const client = new RunnerApiClient({
      apiUrl: "https://api.yaffle.dev",
      jobToken: "runner-token",
      jobId: "job-id",
    })

    await client.uploadPlanFile("https://uploads.yaffle.dev/plan", new ArrayBuffer(0))

    expect(headers?.get("if-none-match")).toBe("*")
  })
})
