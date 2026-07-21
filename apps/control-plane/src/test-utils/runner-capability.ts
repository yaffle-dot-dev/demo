import { createHash } from "node:crypto"

import { and, eq, inArray } from "drizzle-orm"

import { db } from "../lib/db.ts"
import type { ExecutionSnapshotV1 } from "../lib/execution-snapshot.ts"
import { generateRunToken } from "../lib/run-token.ts"
import {
  iacJobHistory,
  iacJobs,
  runGroups,
  stateVersions,
  tfRuns,
  workspaceDeployments,
  workspaces,
} from "../db/schema.ts"

const createdRunIds = new Set<string>()
const createdJobIds = new Set<string>()

export async function cleanupTestRunCapabilities(): Promise<void> {
  const runIds = [...createdRunIds]
  const jobIds = [...createdJobIds]

  if (runIds.length > 0) {
    await db.delete(stateVersions).where(inArray(stateVersions.runId, runIds))
    await db.delete(tfRuns).where(inArray(tfRuns.id, runIds))
  }
  if (jobIds.length > 0) {
    await db.delete(iacJobs).where(inArray(iacJobs.id, jobIds))
    await db.delete(iacJobHistory).where(inArray(iacJobHistory.id, jobIds))
  }
  createdRunIds.clear()
  createdJobIds.clear()
}

export function getTestRunId(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex").slice(0, 32).split("")
  hex[12] = "4"
  hex[16] = "8"
  const value = hex.join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function snapshotForWorkspace(workspace: typeof workspaces.$inferSelect): ExecutionSnapshotV1 {
  return {
    version: 1,
    source: {
      installationId: 1,
      repositoryId: 2,
      ownerId: 3,
      owner: "test-owner",
      repository: workspace.repo,
      defaultBranch: "main",
      ref: workspace.ref,
      commitSha: "test-run-capability-sha",
      baseSha: null,
      actor: { githubId: 4, login: "test-runner" },
    },
    configuration: {
      path: "yaffle.toml",
      revision: "test-run-capability-sha",
      digest: "test-run-capability-digest",
    },
    environment: {
      kind: workspace.environmentKind,
      name: workspace.environmentName,
      sourcePullRequestNumber: workspace.environmentKind === "transient" ? 1 : null,
    },
    workspaces: [
      {
        path: workspace.workspacePath,
        variables: {},
        approval: { required: false, approvers: [] },
        lifecycle: { activation: [], verification: [] },
        automaticPreviewIsolation: false,
      },
    ],
  }
}

export async function createTestRunCapability(
  label: string,
  workspaceId: string,
  orgId: string,
  scopes?: string[],
): Promise<{
  token: string
  runId: string
  jobId: string
  deploymentId: string
  runGroupId: string
}> {
  const workspace = (
    await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  )[0]
  if (!workspace || workspace.orgId !== orgId) {
    throw new Error("Test run capability workspace does not belong to the requested organization")
  }

  let deployment = (
    await db
      .select()
      .from(workspaceDeployments)
      .where(
        and(
          eq(workspaceDeployments.orgId, workspace.orgId),
          eq(workspaceDeployments.repo, workspace.repo),
          eq(workspaceDeployments.environmentName, workspace.environmentName),
          eq(workspaceDeployments.workspacePath, workspace.workspacePath),
        ),
      )
      .limit(1)
  )[0]

  let runGroupId = deployment?.runGroupId ?? null
  if (!runGroupId) {
    const [runGroup] = await db
      .insert(runGroups)
      .values({
        orgId: workspace.orgId,
        repo: workspace.repo,
        environmentKind: workspace.environmentKind,
        environmentName: workspace.environmentName,
        prNumber: workspace.environmentKind === "transient" ? 1 : null,
        ref: workspace.ref,
        headSha: "test-run-capability-sha",
        selectedWorkspacePaths: [workspace.workspacePath],
        executionSnapshot: snapshotForWorkspace(workspace),
        trigger: "manual",
        status: "running",
        workspaceS3Key: `test-run-capabilities/${crypto.randomUUID()}/workspace.tar.gz`,
      })
      .returning()
    runGroupId = runGroup.id

    if (deployment) {
      const [updated] = await db
        .update(workspaceDeployments)
        .set({ runGroupId })
        .where(eq(workspaceDeployments.id, deployment.id))
        .returning()
      deployment = updated
    } else {
      const [createdDeployment] = await db
        .insert(workspaceDeployments)
        .values({
          orgId: workspace.orgId,
          runGroupId,
          repo: workspace.repo,
          environmentKind: workspace.environmentKind,
          environmentName: workspace.environmentName,
          prNumber: workspace.environmentKind === "transient" ? 1 : null,
          workspacePath: workspace.workspacePath,
          ref: workspace.ref,
          headSha: "test-run-capability-sha",
          status: "planning",
          stateKey: `test-run-capabilities/${workspace.id}/terraform.tfstate`,
          mode: "saas",
        })
        .returning()
      deployment = createdDeployment
    }
  }

  if (!deployment || !runGroupId) {
    throw new Error("Failed to create test run capability deployment")
  }

  const jobId = crypto.randomUUID()
  const runId = getTestRunId(label)
  const runType = scopes?.includes("workspace:destroy") ? "destroy" : "plan"
  await db.insert(iacJobs).values({
    id: jobId,
    deploymentId: deployment.id,
    runGroupId,
    jobType: runType,
    status: "running",
    workerId: "test-runner",
    startedAt: new Date(),
  })
  await db
    .insert(tfRuns)
    .values({
      id: runId,
      jobId,
      deploymentId: deployment.id,
      runGroupId,
      runType,
      status: "running",
      startedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tfRuns.id,
      set: {
        deploymentId: deployment.id,
        jobId,
        runGroupId,
        runType,
        planPurpose: "environment",
        status: "running",
        startedAt: new Date(),
        completedAt: null,
      },
    })

  const token = await generateRunToken({
    runId,
    jobId,
    deploymentId: deployment.id,
    runGroupId,
    workspaceId,
    orgId,
    scopes,
  })

  createdRunIds.add(runId)
  createdJobIds.add(jobId)

  return {
    token,
    runId,
    jobId,
    deploymentId: deployment.id,
    runGroupId,
  }
}

export async function generateTestRunToken(
  label: string,
  workspaceId: string,
  orgId: string,
  scopes?: string[],
): Promise<string> {
  return (await createTestRunCapability(label, workspaceId, orgId, scopes)).token
}
