import { afterAll, beforeAll, describe, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

// Set dev auth before importing routes that initialize Better Auth.
import { createTestContext, type TestContext } from "../test-utils/auth.ts"

import { db } from "../lib/db.ts"
import { auth } from "../lib/better-auth.ts"
import { apikey } from "../db/auth-schema.ts"
import { createPrincipal, ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import {
  lifecycleEvents,
  lifecycleItems,
  lifecycleRuns,
  previews,
  principalRepoBindings,
  principals,
  runGroups,
  tfRuns,
} from "../db/schema.ts"
import { reposRoute } from "./repos.ts"

const app = new Hono()
app.route("/api/orgs", reposRoute)

let producer: TestContext
let foreign: TestContext
let scopedApiKeyHeaders: Headers
let wrongRepoApiKeyHeaders: Headers
let unscopedApiKeyHeaders: Headers
let lifecyclePrincipalId: string
let lifecycleBindingId: string
let lifecycleRunId: string
let lifecycleItemId: string
const apiKeyIds: string[] = []

beforeAll(async () => {
  producer = await createTestContext({ orgSlug: "output-producer" })
  foreign = await createTestContext({ orgSlug: "output-foreign" })
  const createKey = async (repo?: string): Promise<Headers> => {
    const result = await auth.api.createApiKey({
      body: {
        name: `output-test-${apiKeyIds.length + 1}`,
        expiresIn: 7 * 24 * 60 * 60,
        userId: producer.user.id,
        metadata: { orgId: producer.org.id, access: "read", repo },
        permissions: { yaffle: ["read"] },
      },
    })
    apiKeyIds.push(result.id)
    return new Headers({ Authorization: `Bearer ${result.key}` })
  }
  scopedApiKeyHeaders = await createKey("app")
  wrongRepoApiKeyHeaders = await createKey("other-repo")
  unscopedApiKeyHeaders = await createKey()

  const [runGroup] = await db
    .insert(runGroups)
    .values({
      orgId: producer.org.id,
      repo: "app",
      environmentKind: "named",
      environmentName: "main",
      ref: "refs/heads/main",
      headSha: "abc123def456",
      selectedWorkspacePaths: ["infra"],
      trigger: "push",
      status: "success",
      executionSnapshot: {
        version: 1,
        source: {
          installationId: 1,
          repositoryId: 2,
          ownerId: 3,
          owner: "output-producer",
          repository: "app",
          defaultBranch: "main",
          ref: "refs/heads/main",
          commitSha: "abc123def456",
          baseSha: null,
          actor: { githubId: 4, login: "builder" },
        },
        configuration: {
          path: "yaffle.toml",
          revision: "abc123def456",
          digest: "output-policy-digest",
        },
        environment: { kind: "named", name: "main", sourcePullRequestNumber: null },
        workspaces: [
          {
            path: "infra",
            variables: {},
            approval: { required: false, approvers: [] },
            lifecycle: { activation: [], verification: [] },
            outputs: {
              carried: { visibility: "internal" },
              endpoint: { visibility: "internal" },
              password: { visibility: "internal" },
            },
            automaticPreviewIsolation: false,
          },
        ],
      },
    })
    .returning()
  const lifecyclePrincipal = await createPrincipal({ type: "anonymous_session" })
  lifecyclePrincipalId = lifecyclePrincipal.id
  const lifecycleBinding = await ensurePrincipalRepoBinding({
    principalId: lifecyclePrincipal.id,
    canonicalRepoNamespace: "output-producer--app",
    localRepoFingerprint: "hosted-output-lifecycle",
  })
  lifecycleBindingId = lifecycleBinding.id
  await db
    .update(runGroups)
    .set({ repoBindingId: lifecycleBinding.id })
    .where(eq(runGroups.id, runGroup.id))
  const [lifecycleRun] = await db
    .insert(lifecycleRuns)
    .values({
      principalId: lifecyclePrincipal.id,
      runGroupId: runGroup.id,
      repoBindingId: lifecycleBinding.id,
      environmentName: "main",
      executionMode: "cloud",
      status: "running",
    })
    .returning()
  lifecycleRunId = lifecycleRun.id
  const [lifecycleItem] = await db
    .insert(lifecycleItems)
    .values({
      runId: lifecycleRun.id,
      workspacePath: "infra",
      key: "deploy",
      phase: "activation",
      kind: "webhook",
      state: "running",
      failurePolicy: "failed",
      scopes: ["usable"],
      destinationUrl: "https://hooks.example.test/deploy",
      destinationClass: "public",
      dispatchMode: "cloud",
      metadata: {
        hostedPayload: {
          outputs: { endpoint: { value: "must-not-leak-hosted-payload", sensitive: false } },
        },
      },
    })
    .returning()
  lifecycleItemId = lifecycleItem.id
  const [deployment] = await db
    .insert(previews)
    .values({
      orgId: producer.org.id,
      runGroupId: runGroup.id,
      repo: "app",
      environmentKind: "named",
      environmentName: "main",
      workspacePath: "infra",
      ref: "refs/heads/main",
      headSha: "abc123def456",
      status: "ready",
      stateKey: "environments/main/infra/terraform.tfstate",
      mode: "saas",
    })
    .returning()
  await db.insert(tfRuns).values({
    deploymentId: deployment.id,
    runGroupId: runGroup.id,
    runType: "apply",
    status: "success",
    outputs: {
      endpoint: { value: "https://api.example.test", type: "string", sensitive: false },
      password: { value: "do-not-expose", type: "string", sensitive: true },
      unselected: { value: "internal-only", type: "string", sensitive: false },
    },
    completedAt: new Date(),
  })
  await db.insert(tfRuns).values({
    deploymentId: deployment.id,
    runGroupId: runGroup.id,
    runType: "apply",
    status: "skipped",
    outputs: {
      carried: { value: "current-policy", type: "string", sensitive: false },
      endpoint: { value: "https://api.example.test", type: "string", sensitive: false },
      password: { value: "do-not-expose", type: "string", sensitive: true },
      unselected: { value: "internal-only", type: "string", sensitive: false },
    },
    completedAt: new Date(),
  })
})

afterAll(async () => {
  await db.delete(lifecycleEvents).where(eq(lifecycleEvents.itemId, lifecycleItemId))
  await db.delete(lifecycleItems).where(eq(lifecycleItems.id, lifecycleItemId))
  await db.delete(lifecycleRuns).where(eq(lifecycleRuns.id, lifecycleRunId))
  await db.delete(tfRuns)
  await db.delete(previews)
  await db.delete(runGroups)
  await db.delete(principalRepoBindings).where(eq(principalRepoBindings.id, lifecycleBindingId))
  await db.delete(principals).where(eq(principals.id, lifecyclePrincipalId))
  for (const id of apiKeyIds) {
    await db.delete(apikey).where(eq(apikey.id, id))
  }
})

describe("environment output authorization", () => {
  test("redacts sensitive values from viewer workspace and run JSON", async () => {
    const response = await app.request("/api/orgs/output-producer/repos/app/environment/main", {
      headers: producer.headers,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    const workspace = body.data.workspaces[0]
    expect(workspace.outputs.password).toEqual({
      value: null,
      type: "string",
      sensitive: true,
    })
    expect(workspace.runs[0].outputs.password.value).toBeNull()
    expect(JSON.stringify(body)).not.toContain("do-not-expose")
    expect(JSON.stringify(body)).not.toContain("must-not-leak-hosted-payload")
  })

  test("returns only explicitly selected outputs to automation", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main?output_audience=automation",
      { headers: producer.headers },
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    const workspace = body.data.workspaces[0]
    expect(Object.keys(workspace.outputs).sort()).toEqual(["carried", "endpoint", "password"])
    expect(workspace.outputs.carried.value).toBe("current-policy")
    expect(Object.keys(workspace.runs[0].outputs).sort()).toEqual([
      "carried",
      "endpoint",
      "password",
    ])
    expect(workspace.outputs.password.value).toBeNull()
    expect(JSON.stringify(body)).not.toContain("internal-only")
  })

  test("denies a principal from another organization", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main?output_audience=automation",
      { headers: foreign.headers },
    )

    expect(response.status).toBe(403)
  })

  test("allows a repository-scoped API key to fetch automation outputs", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main?output_audience=automation",
      { headers: scopedApiKeyHeaders },
    )

    expect(response.status).toBe(200)
  })

  test("denies same-org API keys scoped to another repository", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main?output_audience=automation",
      { headers: wrongRepoApiKeyHeaders },
    )

    expect(response.status).toBe(403)
  })

  test("denies unscoped API keys from automation outputs", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main?output_audience=automation",
      { headers: unscopedApiKeyHeaders },
    )

    expect(response.status).toBe(403)
  })

  test("opens the environment stream with authenticated request headers", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main/stream?output_audience=automation",
      { headers: producer.headers },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    await response.body?.cancel()
  })

  test("opens the environment stream with a repository-scoped bearer API key", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main/stream?output_audience=automation",
      { headers: scopedApiKeyHeaders },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    await response.body?.cancel()
  })

  test("denies a wrong-repository API key from the environment stream", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main/stream?output_audience=automation",
      { headers: wrongRepoApiKeyHeaders },
    )

    expect(response.status).toBe(403)
  })

  test("does not accept a bearer token in the environment stream URL", async () => {
    const response = await app.request(
      "/api/orgs/output-producer/repos/app/environment/main/stream?token=do-not-put-tokens-in-urls",
    )

    expect(response.status).toBe(401)
  })
})
