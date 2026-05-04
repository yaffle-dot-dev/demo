import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { resetRateLimitStore } from "../lib/request-protection.ts"
import { cleanupTestData } from "../test-utils/auth.ts"
import { lifecycleRoute } from "./lifecycle.ts"
import { localFirstRoute } from "./local-first.ts"

const TEST_FEATURE_TOKEN = "test-feature-token"

function featureHeaders(): Record<string, string> {
  return {
    "feature-token": TEST_FEATURE_TOKEN,
  }
}

describe("lifecycleRoute", () => {
  const app = new Hono()
  app.route("/api", localFirstRoute)
  app.route("/api/lifecycle", lifecycleRoute)

  beforeEach(async () => {
    process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN = TEST_FEATURE_TOKEN
    resetRateLimitStore()
    await cleanupTestData()
  })

  afterEach(async () => {
    delete process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN
    resetRateLimitStore()
    await cleanupTestData()
  })

  test("creates lifecycle state and completes a callback", async () => {
    const sessionRes = await app.fetch(
      new Request("http://localhost/api/sessions/anonymous", {
        method: "POST",
        headers: featureHeaders(),
      }),
    )
    const sessionBody = await sessionRes.json() as { data: { token: string } }

    const authHeaders = {
      ...featureHeaders(),
      Authorization: `Bearer ${sessionBody.data.token}`,
      "Content-Type": "application/json",
    }

    const runRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/runs", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          executionMode: "local",
        }),
      }),
    )
    expect(runRes.status).toBe(201)
    const runBody = await runRes.json() as { data: { id: string } }

    const itemRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/items", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          runId: runBody.data.id,
          workspacePath: "apps/web/infra",
          key: "preview-ready",
          phase: "activation",
          kind: "webhook",
          failurePolicy: "failed",
          scopes: ["usable", "acceptable"],
          destinationUrl: "http://localhost:8787/hooks/preview-ready",
          destinationClass: "private_local",
          dispatchMode: "local",
          callbackTtlMinutes: 60,
        }),
      }),
    )
    expect(itemRes.status).toBe(201)
    const itemBody = await itemRes.json() as { data: { id: string; onCompletionUrl: string } }

    const stateBeforeRes = await app.fetch(
      new Request(
        "http://localhost/api/lifecycle/state?canonicalRepoNamespace=test-org--fixture&localRepoFingerprint=repo-fingerprint-1&environmentName=main",
        {
          headers: authHeaders,
        },
      ),
    )
    expect(stateBeforeRes.status).toBe(200)
    const stateBeforeBody = await stateBeforeRes.json() as {
      data: { items: Array<{ state: string }> }
    }
    expect(stateBeforeBody.data.items[0]?.state).toBe("pending")

    const callbackRes = await app.fetch(
      new Request(itemBody.data.onCompletionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "succeeded",
          summary: "preview is ready",
        }),
      }),
    )
    expect(callbackRes.status).toBe(200)

    const itemAfterRes = await app.fetch(
      new Request(`http://localhost/api/lifecycle/items/${itemBody.data.id}`, {
        headers: authHeaders,
      }),
    )
    expect(itemAfterRes.status).toBe(200)
    const itemAfterBody = await itemAfterRes.json() as {
      data: { state: string; summary: string }
    }
    expect(itemAfterBody.data.state).toBe("succeeded")
    expect(itemAfterBody.data.summary).toBe("preview is ready")
  })
})
