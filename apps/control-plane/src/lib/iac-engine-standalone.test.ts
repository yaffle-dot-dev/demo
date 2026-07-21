import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, expect, test } from "@yaffle/test"

import type { TerraformResult } from "@yaffle/shared"
import { eq } from "drizzle-orm"

import { createIacJob } from "../db/queries/iac-jobs.ts"
import { createOrg, updateOrg } from "../db/queries/organizations.ts"
import { createPrincipal, ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import { createRunGroup } from "../db/queries/run-groups.ts"
import { upsertDeployment } from "../db/queries/workspace-deployments.ts"
import {
  iacJobHistory,
  iacJobs,
  jobs,
  organizations,
  principalRepoBindings,
  principals,
  previews,
  runGroups,
  tfRuns,
} from "../db/schema.ts"
import { db } from "./db.ts"
import { executeJobStandalone } from "./iac-engine-standalone.ts"
import type { Runner, RunOpts } from "./runner.ts"

class CapturingRunner implements Runner {
  call: RunOpts | null = null

  async run(opts: RunOpts): Promise<TerraformResult> {
    this.call = opts
    return {
      success: false,
      command: opts.command,
      output: "",
      errorMessage: "stop after capturing execution input",
      durationMs: 1,
    }
  }
}

let testOrgId: string | null = null

beforeAll(async () => {
  await db.delete(iacJobs)
  await db.delete(iacJobHistory)
  await db.delete(tfRuns)
  await db.delete(previews)
  await db.delete(runGroups)
  await db.delete(principalRepoBindings)
  await db.delete(principals)
})

afterAll(async () => {
  await db.delete(iacJobs)
  await db.delete(iacJobHistory)
  await db.delete(tfRuns)
  await db.delete(previews)
  await db.delete(runGroups)
  await db.delete(principalRepoBindings)
  await db.delete(principals)
  if (testOrgId) {
    await db.delete(jobs).where(eq(jobs.orgId, testOrgId))
    await db.delete(organizations).where(eq(organizations.id, testOrgId))
  }
})

test("passes snapshotted variables and revision to the runner", async () => {
  const org = await createOrg({
    name: "Snapshot Runner",
    slug: `snapshot-runner-${randomUUID()}`,
  })
  testOrgId = org.id
  await updateOrg(org.id, { provisioningStatus: "active" })
  const principal = await createPrincipal({ type: "anonymous_session" })
  const repoBinding = await ensurePrincipalRepoBinding({
    principalId: principal.id,
    canonicalRepoNamespace: "test-owner--fixture",
    localRepoFingerprint: `snapshot-runner-${randomUUID()}`,
  })
  const runGroup = await createRunGroup({
    orgId: org.id,
    repoBindingId: repoBinding.id,
    repo: "fixture",
    environmentKind: "transient",
    environmentName: "pr-7",
    prNumber: 7,
    ref: "refs/heads/feature/snapshot",
    headSha: "snapshot-sha",
    selectedWorkspacePaths: ["infra"],
    workspaceS3Key: "test-owner/fixture/snapshot-sha/workspace.tar.gz",
    trigger: "pr_opened",
    executionSnapshot: {
      version: 1,
      source: {
        installationId: 0,
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
      workspaces: [
        {
          path: "infra",
          variables: { release: "snapshotted" },
          approval: { required: false, approvers: [] },
          lifecycle: { activation: [], verification: [] },
          outputs: {},
          automaticPreviewIsolation: false,
        },
      ],
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
  const job = await createIacJob({
    deploymentId: deployment.id,
    runGroupId: runGroup.id,
    jobType: "plan",
  })
  const runner = new CapturingRunner()

  await executeJobStandalone(job.id, runner)

  expect(runner.call).toMatchObject({
    owner: "test-owner",
    repo: "fixture",
    headSha: "snapshot-sha",
    variables: {
      environment: "pr-7",
      environment_kind: "transient",
      release: "snapshotted",
    },
  })
})
