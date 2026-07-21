import { afterEach, beforeEach, describe, expect, test } from "@yaffle/test"
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
    const sessionBody = (await sessionRes.json()) as { data: { token: string } }

    const authHeaders = {
      ...featureHeaders(),
      Authorization: `Bearer ${sessionBody.data.token}`,
      "Content-Type": "application/json",
    }

    const clientHostedRunRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/runs", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          executionMode: "cloud",
        }),
      }),
    )
    expect(clientHostedRunRes.status).toBe(400)

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
    const runBody = (await runRes.json()) as { data: { id: string } }

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
          metadata: {
            provider: "nix-ci",
            dispatchId: "dispatch-1",
          },
          selectedOutputNames: [],
          callbackTtlMinutes: 60,
        }),
      }),
    )
    expect(itemRes.status).toBe(201)
    const itemBody = (await itemRes.json()) as { data: { id: string; onCompletionUrl: string } }
    const secondItemRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/items", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          runId: runBody.data.id,
          workspacePath: "apps/web/infra",
          key: "preview-health",
          phase: "verification",
          kind: "webhook",
          failurePolicy: "failed",
          scopes: ["acceptable"],
          destinationUrl: "http://localhost:8787/hooks/preview-health",
          destinationClass: "private_local",
          dispatchMode: "local",
          selectedOutputNames: [],
          callbackTtlMinutes: 60,
        }),
      }),
    )
    expect(secondItemRes.status).toBe(201)
    const secondItemBody = (await secondItemRes.json()) as { data: { id: string } }

    const foreignSessionRes = await app.fetch(
      new Request("http://localhost/api/sessions/anonymous", {
        method: "POST",
        headers: featureHeaders(),
      }),
    )
    const foreignSessionBody = (await foreignSessionRes.json()) as { data: { token: string } }
    const foreignReadRes = await app.fetch(
      new Request(`http://localhost/api/lifecycle/items/${itemBody.data.id}`, {
        headers: {
          ...featureHeaders(),
          Authorization: `Bearer ${foreignSessionBody.data.token}`,
        },
      }),
    )
    expect(foreignReadRes.status).toBe(404)

    const stateBeforeRes = await app.fetch(
      new Request(
        "http://localhost/api/lifecycle/state?canonicalRepoNamespace=test-org--fixture&localRepoFingerprint=repo-fingerprint-1&environmentName=main",
        {
          headers: authHeaders,
        },
      ),
    )
    expect(stateBeforeRes.status).toBe(200)
    const stateBeforeBody = (await stateBeforeRes.json()) as {
      data: { items: Array<{ state: string }> }
    }
    expect(stateBeforeBody.data.items[0]?.state).toBe("pending")

    const runningCallbackRes = await app.fetch(
      new Request(itemBody.data.onCompletionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "running",
          externalUrl: "https://ci.example.com/runs/123",
          metadata: {
            buildNumber: 123,
            hostedPayload: { outputs: { stolen: true } },
          },
        }),
      }),
    )
    expect(runningCallbackRes.status).toBe(200)
    const runningCallbackBody = (await runningCallbackRes.json()) as {
      data: { nextOnCompletionUrl: string }
    }
    const replayedRunningCallbackRes = await app.fetch(
      new Request(itemBody.data.onCompletionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    )
    expect(replayedRunningCallbackRes.status).toBe(404)

    const itemRunningRes = await app.fetch(
      new Request(`http://localhost/api/lifecycle/items/${itemBody.data.id}`, {
        headers: authHeaders,
      }),
    )
    expect(itemRunningRes.status).toBe(200)
    const itemRunningBody = (await itemRunningRes.json()) as {
      data: { state: string; metadata: Record<string, unknown> }
    }
    expect(itemRunningBody.data.state).toBe("running")
    expect(itemRunningBody.data.metadata.provider).toBe("nix-ci")
    expect(itemRunningBody.data.metadata.dispatchId).toBe("dispatch-1")
    expect(itemRunningBody.data.metadata.callback).toBeUndefined()
    expect(itemRunningBody.data.metadata.hostedPayload).toBeUndefined()
    expect(itemRunningBody.data.metadata.externalUrl).toBe("https://ci.example.com/runs/123")

    const terminalCallback = async (): Promise<Response> =>
      await app.fetch(
        new Request(runningCallbackBody.data.nextOnCompletionUrl, {
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
    const callbackResponses = await Promise.all([terminalCallback(), terminalCallback()])
    expect(callbackResponses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
      200, 404,
    ])

    const itemAfterRes = await app.fetch(
      new Request(`http://localhost/api/lifecycle/items/${itemBody.data.id}`, {
        headers: authHeaders,
      }),
    )
    expect(itemAfterRes.status).toBe(200)
    const itemAfterBody = (await itemAfterRes.json()) as {
      data: { state: string; summary: string; metadata: Record<string, unknown> }
    }
    expect(itemAfterBody.data.state).toBe("succeeded")
    expect(itemAfterBody.data.summary).toBe("preview is ready")
    expect(itemAfterBody.data.metadata.provider).toBe("nix-ci")
    expect(itemAfterBody.data.metadata.dispatchId).toBe("dispatch-1")
    expect(itemAfterBody.data.metadata.callback).toBeUndefined()
    expect(itemAfterBody.data.metadata.externalUrl).toBe("https://ci.example.com/runs/123")

    const secondItemAfterRes = await app.fetch(
      new Request(`http://localhost/api/lifecycle/items/${secondItemBody.data.id}`, {
        headers: authHeaders,
      }),
    )
    const secondItemAfterBody = (await secondItemAfterRes.json()) as { data: { state: string } }
    expect(secondItemAfterBody.data.state).toBe("pending")

    const reusedCallbackRes = await app.fetch(
      new Request(runningCallbackBody.data.nextOnCompletionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "succeeded",
        }),
      }),
    )
    expect(reusedCallbackRes.status).toBe(404)
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
    const sessionBody = (await sessionRes.json()) as { data: { token: string } }

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
    const runBody = (await runRes.json()) as { data: { id: string } }

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
          selectedOutputNames: [],
          callbackTtlMinutes: 60,
        }),
      }),
    )
    expect(itemRes.status).toBe(201)
    const itemBody = (await itemRes.json()) as {
      data: { id: string; state: string; onCompletionUrl: string | null }
    }
    expect(itemBody.data.state).toBe("blocked")
    expect(itemBody.data.onCompletionUrl).toBeNull()

    const stateRes = await app.fetch(
      new Request(
        "http://localhost/api/lifecycle/state?canonicalRepoNamespace=test-org--fixture&localRepoFingerprint=repo-fingerprint-1&environmentName=main",
        { headers: authHeaders },
      ),
    )
    const stateBody = (await stateRes.json()) as {
      data: { items: Array<{ state: string; reason: string }> }
    }
    expect(stateBody.data.items[0]?.state).toBe("blocked")
    expect(stateBody.data.items[0]?.reason).toContain("requires principal tier 'paid_cloud'")

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
            request: { url: "http://localhost:8787/hooks/preview-ready", method: "POST" },
          },
          payload: {
            repo_namespace: "test-org--fixture",
            environment: "main",
            workspace_path: "apps/web/infra",
            item_key: "preview-ready",
            phase: "activation",
            outputs: {},
          },
        }),
      }),
    )
    expect(dispatchRes.status).toBe(409)
  })

  test("denies anonymous principals access to connection-backed lifecycle credentials", async () => {
    const org = await createTestOrg({ slug: "lifecycle-dispatch-org" })
    await db
      .update(organizations)
      .set({
        kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
        iamRoleArn: "arn:aws:iam::123456789012:role/yaffle-org-broker-test",
      })
      .where(eq(organizations.id, org.id))
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
    const sessionBody = (await sessionRes.json()) as { data: { token: string } }

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
    const runBody = (await runRes.json()) as { data: { id: string } }

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
          selectedOutputNames: ["password"],
          callbackTtlMinutes: 60,
        }),
      }),
    )
    const itemBody = (await itemRes.json()) as { data: { id: string; onCompletionUrl: string } }

    const privateRunRes = await app.fetch(
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
    const privateRunBody = (await privateRunRes.json()) as { data: { id: string } }
    const privateItemRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/items", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          runId: privateRunBody.data.id,
          workspacePath: "apps/web/infra",
          key: "private-target",
          phase: "activation",
          kind: "webhook",
          failurePolicy: "failed",
          scopes: ["usable"],
          destinationUrl: "https://127.0.0.1/internal",
          destinationClass: "public",
          dispatchMode: "local",
          selectedOutputNames: [],
          callbackTtlMinutes: 60,
        }),
      }),
    )
    const privateItemBody = (await privateItemRes.json()) as { data: { id: string } }
    const privateDispatchRes = await app.fetch(
      new Request("http://localhost/api/lifecycle/dispatch", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          runId: privateRunBody.data.id,
          itemId: privateItemBody.data.id,
          environmentName: "main",
          workspacePath: "apps/web/infra",
          phase: "activation",
          dispatch: {
            kind: "generic",
            request: { url: "https://127.0.0.1/internal", method: "POST" },
          },
          payload: {
            repo_namespace: "test-org--fixture",
            environment: "main",
            workspace_path: "apps/web/infra",
            item_key: "private-target",
            phase: "activation",
            outputs: {},
          },
        }),
      }),
    )
    expect(privateDispatchRes.status).toBe(502)
    expect(JSON.stringify(await privateDispatchRes.json())).toContain("public IP addresses")

    const sensitiveDispatchRes = await app.fetch(
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
            request: { url: "https://hooks.example.com/buildkite", method: "POST" },
          },
          payload: {
            repo_namespace: "test-org--fixture",
            environment: "main",
            workspace_path: "apps/web/infra",
            item_key: "buildkite",
            phase: "activation",
            outputs: {
              password: { value: "do-not-dispatch", sensitive: true },
            },
          },
        }),
      }),
    )

    expect(sensitiveDispatchRes.status).toBe(422)
    expect(await sensitiveDispatchRes.json()).toMatchObject({
      error: {
        code: "SENSITIVE_OUTPUT_NOT_ALLOWED",
        outputNames: ["password"],
      },
    })

    const mismatchedDispatchRes = await app.fetch(
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
            request: { url: "https://hooks.example.com/buildkite", method: "POST" },
          },
          payload: {
            repo_namespace: "another-org--victim",
            environment: "main",
            workspace_path: "apps/web/infra",
            item_key: "buildkite",
            phase: "activation",
            outputs: {},
          },
        }),
      }),
    )
    expect(mismatchedDispatchRes.status).toBe(409)

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

    expect(dispatchRes.status).toBe(403)
    expect(await dispatchRes.json()).toMatchObject({ error: { code: "FORBIDDEN" } })
  })
})
