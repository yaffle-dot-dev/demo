import { randomUUID } from "node:crypto"

import { afterAll, afterEach, beforeAll, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"

import { createOrg } from "../db/queries/organizations.ts"
import {
  createPrincipal,
  ensurePrincipalRepoBinding,
} from "../db/queries/principals.ts"
import { createRunGroup } from "../db/queries/run-groups.ts"
import { upsertDeployment } from "../db/queries/workspace-deployments.ts"
import {
  lifecycleCompletionTokens,
  lifecycleEvents,
  lifecycleItems,
  lifecycleRuns,
  jobs,
  organizations,
  previews,
  principalRepoBindings,
  principals,
  runGroups,
} from "../db/schema.ts"
import { db } from "./db.ts"
import { ExecutionContextAssociationError } from "./execution-snapshot.ts"
import { executeHostedLifecycleForDeployment } from "./hosted-lifecycle.ts"

const originalFetch = globalThis.fetch
let testOrgId: string | null = null

beforeAll(async () => {
  await db.delete(lifecycleCompletionTokens)
  await db.delete(lifecycleEvents)
  await db.delete(lifecycleItems)
  await db.delete(lifecycleRuns)
  await db.delete(previews)
  await db.delete(runGroups)
  await db.delete(principalRepoBindings)
  await db.delete(principals)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(async () => {
  await db.delete(lifecycleCompletionTokens)
  await db.delete(lifecycleEvents)
  await db.delete(lifecycleItems)
  await db.delete(lifecycleRuns)
  await db.delete(previews)
  await db.delete(runGroups)
  await db.delete(principalRepoBindings)
  await db.delete(principals)
  if (testOrgId) {
    await db.delete(jobs).where(eq(jobs.orgId, testOrgId))
    await db.delete(organizations).where(eq(organizations.id, testOrgId))
  }
})

test("dispatches lifecycle hooks from the immutable snapshot", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : {}
    requests.push({
      url,
      body,
    })
    return new Response(null, { status: 204 })
  }

  const org = await createOrg({
    name: "Lifecycle Snapshot",
    slug: `lifecycle-snapshot-${randomUUID()}`,
  })
  testOrgId = org.id
  const principal = await createPrincipal({ type: "anonymous_session" })
  const binding = await ensurePrincipalRepoBinding({
    principalId: principal.id,
    canonicalRepoNamespace: "test-owner--fixture",
    localRepoFingerprint: "hosted-lifecycle-snapshot-test",
  })
  const runGroup = await createRunGroup({
    orgId: org.id,
    repoBindingId: binding.id,
    repo: "fixture",
    environmentKind: "transient",
    environmentName: "pr-7",
    prNumber: 7,
    ref: "refs/heads/feature/snapshot",
    headSha: "snapshot-sha",
    selectedWorkspacePaths: ["infra"],
    trigger: "pr_opened",
    executionSnapshot: {
      version: 1,
      source: {
        installationId: 1,
        repositoryId: 2,
        ownerId: 3,
        owner: "test-owner",
        repository: "fixture",
        defaultBranch: "main",
        ref: "refs/heads/feature/snapshot",
        commitSha: "snapshot-sha",
        baseSha: "base-sha",
        actor: { githubId: 4, login: "octocat" },
      },
      configuration: {
        path: "yaffle.toml",
        revision: "snapshot-sha",
        digest: "snapshot-digest",
      },
      environment: {
        kind: "transient",
        name: "pr-7",
        sourcePullRequestNumber: 7,
      },
      workspaces: [{
        path: "infra",
        variables: {},
        approval: { required: false, approvers: [] },
        lifecycle: {
          activation: [{
            key: "deploy",
            environments: ["pr-7"],
            kind: "generic",
            failure: "failed",
            scopes: [],
            request: {
              url: "https://snapshot.example.test/deploy",
              method: "POST",
            },
          }],
          verification: [],
        },
        automaticPreviewIsolation: false,
      }],
    },
  })
  const deployment = await upsertDeployment({
    orgId: org.id,
    runGroupId: runGroup.id,
    repo: "fixture",
    environmentKind: "transient",
    environmentName: "pr-7",
    prNumber: 7,
    workspacePath: "infra",
    ref: "refs/heads/mutated",
    headSha: "mutated-sha",
    stateKey: "previews/pr-7/terraform.tfstate",
    mode: "saas",
  })

  await executeHostedLifecycleForDeployment({
    runGroupId: runGroup.id,
    deployment,
    outputs: { endpoint: "https://service.example.test" },
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    url: "https://snapshot.example.test/deploy",
    body: {
      git_sha: "snapshot-sha",
      git_base_sha: "base-sha",
      environment: "pr-7",
      workspace_path: "infra",
    },
  })

  const foreignOrg = await createOrg({
    name: "Foreign Lifecycle Snapshot",
    slug: `foreign-lifecycle-snapshot-${randomUUID()}`,
  })
  await expect(executeHostedLifecycleForDeployment({
    runGroupId: runGroup.id,
    deployment: { ...deployment, orgId: foreignOrg.id },
    outputs: {},
  })).rejects.toBeInstanceOf(ExecutionContextAssociationError)
  expect(requests).toHaveLength(1)
  await db.delete(organizations).where(eq(organizations.id, foreignOrg.id))
})
