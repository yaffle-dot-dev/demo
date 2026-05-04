import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { eq } from "drizzle-orm"

import { db } from "../lib/db.ts"

import { storeConnectionSecret } from "../lib/connection-secrets.ts"
import { resetRateLimitStore } from "../lib/request-protection.ts"
import { cleanupTestData, createTestOrg } from "../test-utils/auth.ts"
import { connections, environmentPolicies, organizations, repositories } from "../db/schema.ts"
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

  test("blocks lifecycle items that violate protected environment governance", async () => {
    const org = await createTestOrg({ slug: "protected-org" })
    await db.insert(repositories).values({
      orgId: org.id,
      githubId: 987654321,
      name: "fixture",
      fullName: "test-org/fixture",
      defaultBranch: "main",
      isActive: true,
    })
    await db.insert(environmentPolicies).values({
      orgId: org.id,
      repoFullName: "test-org/fixture",
      environmentName: "main",
      minimumPrincipalTier: "paid_cloud",
      lifecycleDispatch: "central",
      allowedDestinationClasses: ["public"],
    })

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
    const itemBody = await itemRes.json() as {
      data: { state: string; onCompletionUrl: string | null }
    }
    expect(itemBody.data.state).toBe("blocked")
    expect(itemBody.data.onCompletionUrl).toBeNull()

    const stateRes = await app.fetch(
      new Request(
        "http://localhost/api/lifecycle/state?canonicalRepoNamespace=test-org--fixture&localRepoFingerprint=repo-fingerprint-1&environmentName=main",
        { headers: authHeaders },
      ),
    )
    const stateBody = await stateRes.json() as {
      data: { items: Array<{ state: string; reason: string }> }
    }
    expect(stateBody.data.items[0]?.state).toBe("blocked")
    expect(stateBody.data.items[0]?.reason).toContain("requires principal tier 'paid_cloud'")
  })

  test("dispatches a connection-backed lifecycle hook through the control plane", async () => {
    const org = await createTestOrg({ slug: "lifecycle-dispatch-org" })
    await db.update(organizations).set({
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
      iamRoleArn: "arn:aws:iam::123456789012:role/yaffle-org-broker-test",
    }).where(eq(organizations.id, org.id))
    await db.insert(repositories).values({
      orgId: org.id,
      githubId: 111222333,
      name: "fixture",
      fullName: "test-org/fixture",
      defaultBranch: "main",
      isActive: true,
      installationId: 4242,
    })

    const connectionId = crypto.randomUUID()
    const storedSecret = await storeConnectionSecret(
      org.id,
      org.slug,
      connectionId,
      "arn:aws:kms:us-east-1:123456789012:key/test",
      { envVars: [{ key: "BUILDKITE_WEBHOOK_SECRET", value: "super-secret" }] },
    )
    await db.insert(connections).values({
      id: connectionId,
      orgId: org.id,
      name: "buildkite webhook",
      providerType: "buildkite",
      credentialProviderType: "envvar",
      type: "envvar",
      config: {
        providerType: "buildkite",
        credentialProviderType: "envvar",
        environmentScope: ["main"],
        workspaceScope: ["apps/web/infra"],
      },
      secretStore: storedSecret.store,
      secretPath: storedSecret.path,
      secretArn: storedSecret.arn,
    })

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
    const runBody = await runRes.json() as { data: { id: string } }

    const itemRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/items", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          runId: runBody.data.id,
          workspacePath: "apps/web/infra",
          key: "buildkite",
          phase: "activation",
          kind: "webhook",
          failurePolicy: "failed",
          scopes: ["usable"],
          destinationUrl: "https://hooks.example.com/buildkite",
          destinationClass: "public",
          dispatchMode: "local",
          callbackTtlMinutes: 60,
        }),
      }),
    )
    const itemBody = await itemRes.json() as { data: { id: string; onCompletionUrl: string } }

    const originalFetch = globalThis.fetch
    const seen: Array<{ authorization: string | null; signature: string | null }> = []
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        seen.push({
          authorization: headers.get("authorization"),
          signature: headers.get("X-Yaffle-Signature"),
        })
        return new Response(null, { status: 202 })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    const dispatchRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/dispatch", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          runId: runBody.data.id,
          itemId: itemBody.data.id,
          environmentName: "main",
          workspacePath: "apps/web/infra",
          phase: "activation",
          dispatch: {
            kind: "generic",
            request: {
              url: "https://hooks.example.com/buildkite",
              method: "POST",
              auth: {
                scheme: "bearer",
                connection: "buildkite webhook",
              },
            },
          },
          payload: {
            repo_namespace: "test-org--fixture",
            environment: "main",
            workspace_path: "apps/web/infra",
            item_key: "buildkite",
            phase: "activation",
            outputs: {},
            on_completion: itemBody.data.onCompletionUrl,
          },
        }),
      }),
    )

    globalThis.fetch = originalFetch

    expect(dispatchRes.status).toBe(202)
    expect(seen[0]?.authorization).toBe("Bearer super-secret")

    const itemAfterRes = await app.fetch(
      new Request(`http://localhost/api/lifecycle/items/${itemBody.data.id}`, {
        headers: authHeaders,
      }),
    )
    const itemAfterBody = await itemAfterRes.json() as {
      data: { state: string; events: Array<{ eventType: string }> }
    }
    expect(itemAfterBody.data.state).toBe("running")
    expect(itemAfterBody.data.events.some((event) => event.eventType === "dispatched")).toBe(true)
  })
})
