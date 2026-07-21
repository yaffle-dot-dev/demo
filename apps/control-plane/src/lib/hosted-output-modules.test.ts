import { afterEach, beforeEach, describe, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"

import { db } from "./db.ts"
import { ensureAccountPrincipal, ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import { runGroups, hostedOutputModules, repositories } from "../db/schema.ts"
import { cleanupTestData, createTestOrg, createTestUser } from "../test-utils/auth.ts"

import { publishHostedOutputModuleForRunGroupBinding } from "./hosted-output-modules.ts"

describe("publishHostedOutputModuleForRunGroupBinding", () => {
  beforeEach(() => {
    process.env.YAFFLE_AUTH_MODE = "dev"
  })

  afterEach(async () => {
    await cleanupTestData()
  })

  test("publishes hosted output modules under the run group's repo binding", async () => {
    const user = await createTestUser({ id: "hosted-output-user" })
    const org = await createTestOrg({ slug: "test-org" })
    const principal = await ensureAccountPrincipal({ userId: user.id })
    const binding = await ensurePrincipalRepoBinding({
      principalId: principal.id,
      canonicalRepoNamespace: "test-org--fixture",
      localRepoFingerprint: "repo-fingerprint-1",
    })
    await db.insert(repositories).values({
      orgId: org.id,
      githubId: 12345,
      name: "fixture",
      fullName: "test-org/fixture",
      defaultBranch: "main",
      installationId: 67890,
      isActive: true,
    })

    const [runGroup] = await db
      .insert(runGroups)
      .values({
        orgId: org.id,
        repoBindingId: binding.id,
        repo: "fixture",
        environmentKind: "named",
        environmentName: "main",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        trigger: "manual",
        status: "running",
        selectedWorkspacePaths: ["apps/control-plane/infra"],
        executionSnapshot: {
          version: 1,
          source: {
            installationId: 67890,
            repositoryId: 12345,
            ownerId: 1,
            owner: "test-org",
            repository: "fixture",
            defaultBranch: "main",
            ref: "refs/heads/main",
            commitSha: "abc123def456",
            baseSha: null,
            actor: { githubId: null, login: null },
          },
          configuration: {
            path: "yaffle.toml",
            revision: "abc123def456",
            digest: "config-digest",
          },
          environment: { kind: "named", name: "main", sourcePullRequestNumber: null },
          workspaces: [
            {
              path: "apps/control-plane/infra",
              variables: {},
              approval: { required: false, approvers: [] },
              lifecycle: { activation: [], verification: [] },
              outputs: { api_url: { visibility: "internal" } },
              automaticPreviewIsolation: false,
            },
          ],
        },
      })
      .returning()

    const version = await publishHostedOutputModuleForRunGroupBinding({
      runGroupId: runGroup.id,
      environmentName: "main",
      workspacePath: "apps/control-plane/infra",
      outputs: {
        api_url: { value: "https://api.yaffle.dev", sensitive: false },
        database_password: { value: "do-not-publish", sensitive: true },
      },
    })

    expect(version).toBe("1.0.1")

    const rows = await db
      .select()
      .from(hostedOutputModules)
      .where(eq(hostedOutputModules.canonicalRepoNamespace, "test-org--fixture"))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.principalId).toBe(principal.id)
    expect(rows[0]?.repoBindingId).toBe(binding.id)
    expect(rows[0]?.environmentName).toBe("main")
    expect(rows[0]?.workspacePath).toBe("apps/control-plane/infra")
    expect(rows[0]?.outputs).toEqual({
      api_url: { value: "https://api.yaffle.dev", sensitive: false },
    })

    await db
      .update(repositories)
      .set({ fullName: "other-owner/fixture" })
      .where(eq(repositories.orgId, org.id))
    expect(
      await publishHostedOutputModuleForRunGroupBinding({
        runGroupId: runGroup.id,
        environmentName: "main",
        workspacePath: "apps/control-plane/infra",
        outputs: { api_url: { value: "https://other.example", sensitive: false } },
      }),
    ).toBeNull()
  })

  test("refuses to publish without an immutable repo-bound execution context", async () => {
    const org = await createTestOrg({ slug: "test-org-webhook" })
    await db.insert(repositories).values({
      orgId: org.id,
      githubId: 22222,
      name: "fixture",
      fullName: "test-org-webhook/fixture",
      defaultBranch: "main",
      installationId: 67891,
      isActive: true,
    })

    const [runGroup] = await db
      .insert(runGroups)
      .values({
        orgId: org.id,
        repo: "fixture",
        environmentKind: "named",
        environmentName: "main",
        ref: "refs/heads/main",
        headSha: "fff111",
        trigger: "push",
        status: "running",
      })
      .returning()

    const version = await publishHostedOutputModuleForRunGroupBinding({
      runGroupId: runGroup.id,
      environmentName: "main",
      workspacePath: "infra/shared",
      outputs: { shared: { value: true, sensitive: false } },
    })

    expect(version).toBeNull()

    const rows = await db
      .select()
      .from(hostedOutputModules)
      .where(eq(hostedOutputModules.canonicalRepoNamespace, "test-org-webhook--fixture"))
    expect(rows).toHaveLength(0)
  })
})
