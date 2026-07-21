import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"

import { account, user } from "../db/auth-schema.ts"
import { createOrg } from "../db/queries/organizations.ts"
import { createIacJob } from "../db/queries/iac-jobs.ts"
import { createPrincipal, ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import { upsertDeployment } from "../db/queries/workspace-deployments.ts"
import {
  organizations,
  orgMemberships,
  jobs,
  iacJobs,
  previews,
  principalRepoBindings,
  principals,
  runGroups,
  tfRuns,
} from "../db/schema.ts"
import { db } from "./db.ts"
import {
  applyDecisionMatchesExecution,
  authorizeInfrastructureRole,
  authorizeExecutionMutation,
  ExecutionMutationDeniedError,
  isApplyDecision,
} from "./execution-mutation.ts"
import { pausePreview, queueAutoApply, triggerApply } from "./webhook-handler.ts"

interface Fixture {
  orgId: string
  principalId: string
  bindingId: string
  runGroupId: string
  deploymentId: string
  planRunId: string
}

const fixtures: Fixture[] = []
const authUserIds: string[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const userId of authUserIds.splice(0)) {
    await db.delete(user).where(eq(user.id, userId))
  }
  for (const fixture of fixtures.splice(0)) {
    await db.delete(tfRuns).where(eq(tfRuns.deploymentId, fixture.deploymentId))
    await db.delete(previews).where(eq(previews.id, fixture.deploymentId))
    await db.delete(runGroups).where(eq(runGroups.id, fixture.runGroupId))
    await db.delete(principalRepoBindings).where(eq(principalRepoBindings.id, fixture.bindingId))
    await db.delete(principals).where(eq(principals.id, fixture.principalId))
    await db.delete(jobs).where(eq(jobs.orgId, fixture.orgId))
    await db.delete(organizations).where(eq(organizations.id, fixture.orgId))
  }
})

async function createMutationUser(
  fixture: Fixture,
  role: "viewer" | "approver" | "admin",
  login?: string,
): Promise<string> {
  const userId = randomUUID()
  authUserIds.push(userId)
  await db.insert(user).values({
    id: userId,
    name: "Untrusted display name",
    email: `${userId}@example.test`,
    emailVerified: true,
  })
  await db.insert(orgMemberships).values({ orgId: fixture.orgId, userId, role, source: "manual" })
  if (login) {
    await db.insert(account).values({
      id: randomUUID(),
      accountId: "4242",
      providerId: "github",
      userId,
      accessToken: "test-github-token",
    })
    globalThis.fetch = async (): Promise<Response> =>
      Response.json({ id: 4242, login }, { status: 200 })
  }
  return userId
}

async function createFixture(
  values: {
    environmentKind?: "named" | "transient"
    required?: boolean
    approvers?: string[]
    projectedRequired?: boolean
  } = {},
): Promise<Fixture> {
  const environmentKind = values.environmentKind ?? "transient"
  const required = values.required ?? false
  const approvers = values.approvers ?? []
  const org = await createOrg({
    name: "Mutation Test",
    slug: `mutation-${randomUUID()}`,
  })
  const principal = await createPrincipal({ type: "anonymous_session" })
  const binding = await ensurePrincipalRepoBinding({
    principalId: principal.id,
    canonicalRepoNamespace: "test-owner--fixture",
    localRepoFingerprint: randomUUID(),
  })
  const environmentName = environmentKind === "transient" ? "pr-42" : "main"
  const [runGroup] = await db
    .insert(runGroups)
    .values({
      orgId: org.id,
      repoBindingId: binding.id,
      repo: "fixture",
      environmentKind,
      environmentName,
      prNumber: environmentKind === "transient" ? 42 : null,
      ref: "refs/heads/main",
      headSha: "abc123",
      workspaceS3Key: "run-groups/test/workspace.tar.gz",
      selectedWorkspacePaths: ["infra"],
      trigger: environmentKind === "transient" ? "pr_opened" : "push",
      executionSnapshot: {
        version: 1,
        source: {
          installationId: 1,
          repositoryId: 2,
          ownerId: 3,
          owner: "test-owner",
          repository: "fixture",
          defaultBranch: "main",
          ref: "refs/heads/main",
          commitSha: "abc123",
          baseSha: null,
          actor: { githubId: 4, login: "builder" },
        },
        configuration: {
          path: "yaffle.toml",
          revision: "abc123",
          digest: "approval-policy-digest",
        },
        environment: {
          kind: environmentKind,
          name: environmentName,
          sourcePullRequestNumber: environmentKind === "transient" ? 42 : null,
        },
        workspaces: [
          {
            path: "infra",
            variables: {},
            approval: { required, approvers },
            lifecycle: { activation: [], verification: [] },
            outputs: {},
            automaticPreviewIsolation: false,
          },
        ],
      },
    })
    .returning()
  const deployment = await upsertDeployment({
    orgId: org.id,
    runGroupId: runGroup.id,
    repo: "fixture",
    environmentKind,
    environmentName,
    prNumber: environmentKind === "transient" ? 42 : null,
    workspacePath: "infra",
    ref: "refs/heads/main",
    headSha: "abc123",
    stateKey: `${environmentName}/infra/terraform.tfstate`,
    mode: "saas",
    requireApproval: values.projectedRequired ?? required,
    approvers,
  })
  const [planRun] = await db
    .insert(tfRuns)
    .values({
      deploymentId: deployment.id,
      runGroupId: runGroup.id,
      runType: "plan",
      status: "success",
      completedAt: new Date(),
    })
    .returning()
  const fixture = {
    orgId: org.id,
    principalId: principal.id,
    bindingId: binding.id,
    runGroupId: runGroup.id,
    deploymentId: deployment.id,
    planRunId: planRun.id,
  }
  fixtures.push(fixture)
  return fixture
}

describe("authorizeExecutionMutation", () => {
  test("force unlock requires admin role", () => {
    expect(() => authorizeInfrastructureRole("force_unlock", "viewer")).toThrow(
      "force unlock requires admin role",
    )
    expect(() => authorizeInfrastructureRole("force_unlock", "approver")).toThrow(
      "force unlock requires admin role",
    )
    expect(() => authorizeInfrastructureRole("force_unlock", "admin")).not.toThrow()
  })

  test("denies viewers from infrastructure mutations", async () => {
    const fixture = await createFixture()
    const userId = await createMutationUser(fixture, "viewer")
    await expect(
      authorizeExecutionMutation({
        deploymentId: fixture.deploymentId,
        runGroupId: fixture.runGroupId,
        action: "apply",
        planRunId: fixture.planRunId,
        actor: {
          kind: "human",
          userId,
          role: "viewer",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test.each(["named", "transient"] as const)(
    "allows an approver to apply an unprotected %s environment",
    async (environmentKind) => {
      const fixture = await createFixture({ environmentKind })
      const userId = await createMutationUser(fixture, "approver")
      const result = await authorizeExecutionMutation({
        deploymentId: fixture.deploymentId,
        runGroupId: fixture.runGroupId,
        action: "apply",
        planRunId: fixture.planRunId,
        actor: {
          kind: "human",
          userId,
          role: "approver",
        },
      })

      expect(result.applyDecision).toMatchObject({
        source: "human",
        environmentKind,
        approvalRequired: false,
      })
    },
  )

  test("enforces configured approvers from the immutable snapshot", async () => {
    const fixture = await createFixture({
      required: true,
      approvers: ["github:user:alice"],
    })
    const unauthorizedUserId = await createMutationUser(fixture, "admin", "mallory")

    await expect(
      authorizeExecutionMutation({
        deploymentId: fixture.deploymentId,
        runGroupId: fixture.runGroupId,
        action: "apply",
        planRunId: fixture.planRunId,
        actor: {
          kind: "human",
          userId: unauthorizedUserId,
          role: "admin",
        },
      }),
    ).rejects.toMatchObject({ code: "APPROVER_NOT_AUTHORIZED" })

    const authorizedUserId = await createMutationUser(fixture, "approver", "Alice")
    const result = await authorizeExecutionMutation({
      deploymentId: fixture.deploymentId,
      runGroupId: fixture.runGroupId,
      action: "apply",
      planRunId: fixture.planRunId,
      actor: {
        kind: "human",
        userId: authorizedUserId,
        role: "approver",
      },
    })
    expect(result.applyDecision?.configuredApprovers).toEqual(["github:user:alice"])
  })

  test("enforces configured approvers for named environments", async () => {
    const fixture = await createFixture({
      environmentKind: "named",
      required: true,
      approvers: ["github:user:alice"],
    })
    const userId = await createMutationUser(fixture, "admin", "alice")
    const result = await authorizeExecutionMutation({
      deploymentId: fixture.deploymentId,
      runGroupId: fixture.runGroupId,
      action: "apply",
      planRunId: fixture.planRunId,
      actor: { kind: "human", userId, role: "admin" },
    })

    expect(result.applyDecision).toMatchObject({
      environmentKind: "named",
      actorRole: "admin",
      approvalRequired: true,
    })
  })

  test("scheduler cannot bypass a protected immutable policy through a false projection", async () => {
    const fixture = await createFixture({
      required: true,
      approvers: ["github:user:alice"],
      projectedRequired: false,
    })

    await expect(
      authorizeExecutionMutation({
        deploymentId: fixture.deploymentId,
        runGroupId: fixture.runGroupId,
        action: "apply",
        planRunId: fixture.planRunId,
        actor: { kind: "scheduler" },
      }),
    ).rejects.toBeInstanceOf(ExecutionMutationDeniedError)
    await expect(
      authorizeExecutionMutation({
        deploymentId: fixture.deploymentId,
        runGroupId: fixture.runGroupId,
        action: "apply",
        planRunId: fixture.planRunId,
        actor: { kind: "scheduler" },
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_POLICY_MISMATCH" })
  })

  test("low-level apply job creation requires an authorized decision", async () => {
    const fixture = await createFixture()
    await expect(
      createIacJob({
        deploymentId: fixture.deploymentId,
        runGroupId: fixture.runGroupId,
        jobType: "apply",
      }),
    ).rejects.toThrow("Apply jobs require an authorized decision")

    const authorized = await authorizeExecutionMutation({
      deploymentId: fixture.deploymentId,
      runGroupId: fixture.runGroupId,
      action: "apply",
      planRunId: fixture.planRunId,
      actor: {
        kind: "human",
        userId: await createMutationUser(fixture, "approver"),
        role: "approver",
      },
    })
    await expect(
      createIacJob({
        deploymentId: fixture.deploymentId,
        runGroupId: fixture.runGroupId,
        jobType: "apply",
        applyDecision: {
          ...authorized.applyDecision!,
          planRunId: randomUUID(),
        },
      }),
    ).rejects.toThrow("Apply jobs require an authorized decision")
  })

  test("scheduler does not queue apply when the projection disables immutable approval", async () => {
    const fixture = await createFixture({
      required: true,
      approvers: ["github:user:alice"],
      projectedRequired: false,
    })
    await db
      .update(previews)
      .set({ status: "awaiting_apply", statusChangedAt: new Date(Date.now() - 60_000) })
      .where(eq(previews.id, fixture.deploymentId))
    await expect(queueAutoApply(fixture.deploymentId)).rejects.toMatchObject({
      code: "APPROVAL_POLICY_MISMATCH",
    })
    const queuedApplies = await db
      .select()
      .from(iacJobs)
      .where(eq(iacJobs.deploymentId, fixture.deploymentId))
    expect(queuedApplies).toHaveLength(0)
  })

  test("scheduler cannot auto-apply a correctly persisted protected policy", async () => {
    const fixture = await createFixture({
      required: true,
      approvers: ["github:user:alice"],
    })
    await db
      .update(previews)
      .set({ status: "awaiting_apply", statusChangedAt: new Date(Date.now() - 60_000) })
      .where(eq(previews.id, fixture.deploymentId))

    await expect(queueAutoApply(fixture.deploymentId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const queuedApplies = await db
      .select()
      .from(iacJobs)
      .where(eq(iacJobs.deploymentId, fixture.deploymentId))
    expect(queuedApplies).toHaveLength(0)
  })

  test.each(["named", "transient"] as const)(
    "scheduler persists an authorized decision for unprotected %s apply",
    async (environmentKind) => {
      const fixture = await createFixture({ environmentKind })
      await db
        .update(previews)
        .set({ status: "awaiting_apply", statusChangedAt: new Date(Date.now() - 60_000) })
        .where(eq(previews.id, fixture.deploymentId))

      const result = await queueAutoApply(fixture.deploymentId)
      expect(result?.jobId).toBeDefined()
      const [job] = await db
        .select()
        .from(iacJobs)
        .where(eq(iacJobs.deploymentId, fixture.deploymentId))
      expect(job.applyDecision).toMatchObject({
        source: "scheduler",
        planRunId: fixture.planRunId,
        environmentKind,
        approvalRequired: false,
      })
      expect(isApplyDecision(job.applyDecision)).toBe(true)
    },
  )

  test("pause cannot report success after an apply is queued", async () => {
    const fixture = await createFixture()
    await db
      .update(previews)
      .set({ status: "awaiting_apply" })
      .where(eq(previews.id, fixture.deploymentId))
    const actor = {
      kind: "human" as const,
      userId: await createMutationUser(fixture, "approver"),
      role: "approver",
    }

    await triggerApply({ previewId: fixture.deploymentId, actor })
    await expect(pausePreview({ previewId: fixture.deploymentId, actor })).rejects.toThrow(
      "apply already queued or in progress",
    )
  })

  test("runner validation rejects stale and scheduler-forged protected decisions", () => {
    const decision = {
      version: 1 as const,
      action: "apply" as const,
      source: "scheduler" as const,
      actorUserId: null,
      actorGithubLogin: null,
      actorRole: null,
      runGroupId: randomUUID(),
      planRunId: randomUUID(),
      workspacePath: "infra",
      environmentKind: "named" as const,
      approvalRequired: true,
      configuredApprovers: ["github:user:alice"],
      configurationDigest: "current-digest",
      decidedAt: new Date().toISOString(),
    }

    expect(
      applyDecisionMatchesExecution({
        decision,
        runGroupId: decision.runGroupId,
        planRunId: decision.planRunId,
        workspacePath: "infra",
        environmentKind: "named",
        configurationDigest: "current-digest",
        approval: { required: true, approvers: ["github:user:alice"] },
      }),
    ).toBe(false)
    expect(
      applyDecisionMatchesExecution({
        decision: {
          ...decision,
          source: "human",
          actorUserId: randomUUID(),
          actorGithubLogin: "alice",
        },
        runGroupId: decision.runGroupId,
        planRunId: decision.planRunId,
        workspacePath: "infra",
        environmentKind: "named",
        configurationDigest: "changed-digest",
        approval: { required: true, approvers: ["github:user:alice"] },
      }),
    ).toBe(false)
  })
})
