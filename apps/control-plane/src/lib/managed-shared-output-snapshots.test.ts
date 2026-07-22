import { randomUUID } from "node:crypto"

import { afterAll, beforeEach, describe, expect, test } from "@yaffle/test"
import { eq, sql } from "drizzle-orm"

import { createOrg } from "../db/queries/organizations.ts"
import { createRunGroup } from "../db/queries/run-groups.ts"
import {
  repositories,
  runGroupSharedOutputBindings,
  sharedOutputSnapshots,
  stateVersions,
  tfRuns,
  workspaceDeployments,
  workspaces,
} from "../db/schema.ts"
import { db } from "./db.ts"
import {
  bindManagedSharedOutputSnapshots,
  ManagedSharedOutputError,
  publishManagedSharedOutputSnapshotForApply,
  publishManagedSharedOutputSnapshotForConvergence,
  resolveBoundManagedSharedOutput,
} from "./managed-shared-output-snapshots.ts"

function assertTestDatabase(): void {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) {
    throw new Error("Managed shared output tests require the test database")
  }
}

async function truncateTestData(): Promise<void> {
  assertTestDatabase()
  await db.execute(sql`TRUNCATE TABLE organizations CASCADE`)
}

describe("managed shared output snapshots", () => {
  beforeEach(truncateTestData)
  afterAll(truncateTestData)

  async function createNamedProducer(values?: { outputSensitive?: boolean }): Promise<{
    orgId: string
    repo: string
    runGroupId: string
    deploymentId: string
    runId: string
    jobId: string
  }> {
    const org = await createOrg({ name: "Snapshot Test", slug: "snapshot-test" })
    await db.insert(repositories).values({
      orgId: org.id,
      installationId: 123,
      githubId: 456,
      name: "platform",
      fullName: "snapshot-test/platform",
    })
    const runGroup = await createRunGroup({
      orgId: org.id,
      repo: "platform",
      environmentKind: "named",
      environmentName: "production",
      ref: "refs/heads/main",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      trigger: "push",
      status: "running",
      selectedWorkspacePaths: ["infra/shared"],
      executionSnapshot: {
        version: 1,
        source: {
          installationId: 123,
          repositoryId: 456,
          ownerId: 789,
          owner: "snapshot-test",
          repository: "platform",
          defaultBranch: "main",
          ref: "refs/heads/main",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          baseSha: null,
          actor: { githubId: 789, login: "publisher" },
        },
        configuration: {
          path: "yaffle.toml",
          revision: "0123456789abcdef0123456789abcdef01234567",
          digest: "configuration-digest",
        },
        environment: { kind: "named", name: "production", sourcePullRequestNumber: null },
        workspaces: [
          {
            path: "infra/shared",
            variables: {},
            approval: { required: false, approvers: [] },
            lifecycle: { activation: [], verification: [] },
            outputs: {
              network_id: { visibility: "internal" },
              subnet_ids: { visibility: "internal" },
              database_password: { visibility: "internal" },
            },
            automaticPreviewIsolation: false,
          },
        ],
      },
    })
    const [deployment] = await db
      .insert(workspaceDeployments)
      .values({
        orgId: org.id,
        runGroupId: runGroup.id,
        repo: "platform",
        environmentKind: "named",
        environmentName: "production",
        workspacePath: "infra/shared",
        ref: "refs/heads/main",
        headSha: runGroup.headSha,
        stateKey: "production/infra/shared/terraform.tfstate",
        mode: "terraform",
      })
      .returning()
    const [workspace] = await db
      .insert(workspaces)
      .values({
        orgId: org.id,
        name: `platform-production-${randomUUID()}`,
        repo: "platform",
        workspacePath: "infra/shared",
        environmentKind: "named",
        environmentName: "production",
        ref: "refs/heads/main",
      })
      .returning()
    const jobId = randomUUID()
    const [run] = await db
      .insert(tfRuns)
      .values({
        jobId,
        deploymentId: deployment.id,
        runGroupId: runGroup.id,
        runType: "apply",
        status: "success",
      })
      .returning()
    const [state] = await db
      .insert(stateVersions)
      .values({
        workspaceId: workspace.id,
        serial: 7,
        md5: "state-fingerprint",
        size: 123,
        s3Key: "opaque/state/key",
        status: "finalized",
        runId: run.id,
        jobId,
        outputs: {
          network_id: { value: "vpc-123", sensitive: false },
          subnet_ids: { value: ["subnet-a", "subnet-b"], sensitive: false },
          database_password: {
            value: "do-not-persist",
            sensitive: values?.outputSensitive ?? true,
          },
        },
      })
      .returning()
    await db
      .update(workspaces)
      .set({ currentStateVersionId: state.id })
      .where(eq(workspaces.id, workspace.id))

    return {
      orgId: org.id,
      repo: "platform",
      runGroupId: runGroup.id,
      deploymentId: deployment.id,
      runId: run.id,
      jobId,
    }
  }

  async function createTransientConsumer(values: { orgId: string; repo: string }): Promise<string> {
    const runGroup = await createRunGroup({
      orgId: values.orgId,
      repo: values.repo,
      environmentKind: "transient",
      environmentName: "pr-84",
      prNumber: 84,
      ref: "refs/heads/feature/snapshots",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      trigger: "pr_opened",
      status: "pending",
      selectedWorkspacePaths: ["apps/api/infra"],
      executionSnapshot: {
        version: 1,
        source: {
          installationId: 123,
          repositoryId: 456,
          ownerId: 789,
          owner: "snapshot-test",
          repository: values.repo,
          defaultBranch: "main",
          ref: "refs/heads/feature/snapshots",
          commitSha: "abcdef0123456789abcdef0123456789abcdef01",
          baseSha: null,
          actor: { githubId: 789, login: "consumer" },
        },
        configuration: {
          path: "yaffle.toml",
          revision: "abcdef0123456789abcdef0123456789abcdef01",
          digest: "consumer-configuration-digest",
        },
        environment: { kind: "transient", name: "pr-84", sourcePullRequestNumber: 84 },
        managedOutputProducers: [
          { path: "infra/shared", environmentNames: ["production"] },
          { path: "infra/missing", environmentNames: ["production"] },
        ],
        workspaces: [
          {
            path: "apps/api/infra",
            variables: {},
            approval: { required: false, approvers: [] },
            lifecycle: { activation: [], verification: [] },
            outputs: {},
            automaticPreviewIsolation: false,
          },
        ],
      },
    })
    return runGroup.id
  }

  test("publishes an immutable provenance-bearing snapshot for the exact named apply", async () => {
    const producer = await createNamedProducer()

    const [snapshot, duplicate] = await Promise.all([
      publishManagedSharedOutputSnapshotForApply({
        ...producer,
        workspacePath: "infra/shared",
      }),
      publishManagedSharedOutputSnapshotForApply({
        ...producer,
        workspacePath: "infra/shared",
      }),
    ])

    expect(snapshot).toMatchObject({
      contractVersion: 1,
      publicationVersion: 1,
      producer: {
        organizationId: producer.orgId,
        repository: "platform",
        workspace: "infra/shared",
        environment: { class: "named_managed", name: "production" },
      },
      sourceRevision: { commitSha: "0123456789abcdef0123456789abcdef01234567" },
      state: { serial: 7 },
      values: {
        network_id: { value: "vpc-123", sensitive: false },
        database_password: { value: null, sensitive: true },
      },
    })
    expect(snapshot?.snapshotId).toMatch(/^sos_[A-Za-z0-9]+$/)
    expect(snapshot?.state.identity).toMatch(/^statev_[A-Za-z0-9]+$/)
    expect(duplicate?.snapshotId).toBe(snapshot?.snapshotId)

    expect(await db.select().from(sharedOutputSnapshots)).toHaveLength(1)
  })

  test("publishes current named state when convergence requires no apply", async () => {
    const producer = await createNamedProducer()

    const snapshot = await publishManagedSharedOutputSnapshotForConvergence({
      runGroupId: producer.runGroupId,
      deploymentId: producer.deploymentId,
      workspacePath: "infra/shared",
    })

    expect(snapshot).toMatchObject({
      publicationVersion: 1,
      state: { serial: 7 },
      values: { network_id: { value: "vpc-123", sensitive: false } },
    })
  })

  test("pins an authorized named snapshot without adding the producer to the transient graph", async () => {
    const producer = await createNamedProducer()
    await publishManagedSharedOutputSnapshotForApply({
      ...producer,
      workspacePath: "infra/shared",
    })
    const transientRunGroup = await createRunGroup({
      orgId: producer.orgId,
      repo: producer.repo,
      environmentKind: "transient",
      environmentName: "pr-42",
      prNumber: 42,
      ref: "refs/heads/feature/test",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      trigger: "pr_opened",
      status: "pending",
      selectedWorkspacePaths: ["apps/api/infra"],
      executionSnapshot: {
        version: 1,
        source: {
          installationId: 123,
          repositoryId: 456,
          ownerId: 789,
          owner: "snapshot-test",
          repository: "platform",
          defaultBranch: "main",
          ref: "refs/heads/feature/test",
          commitSha: "abcdef0123456789abcdef0123456789abcdef01",
          baseSha: null,
          actor: { githubId: 789, login: "consumer" },
        },
        configuration: {
          path: "yaffle.toml",
          revision: "abcdef0123456789abcdef0123456789abcdef01",
          digest: "consumer-configuration-digest",
        },
        environment: { kind: "transient", name: "pr-42", sourcePullRequestNumber: 42 },
        managedOutputProducers: [{ path: "infra/shared", environmentNames: ["production"] }],
        workspaces: [
          {
            path: "apps/api/infra",
            variables: {},
            approval: { required: false, approvers: [] },
            lifecycle: { activation: [], verification: [] },
            outputs: {},
            automaticPreviewIsolation: false,
          },
        ],
      },
    })

    const bindings = await bindManagedSharedOutputSnapshots({
      runGroupId: transientRunGroup.id,
      orgId: producer.orgId,
      repo: producer.repo,
      environmentKind: "transient",
      selectedWorkspacePaths: ["apps/api/infra"],
      references: [
        {
          consumerWorkspacePath: "apps/api/infra",
          producerWorkspacePath: "infra/shared",
          moduleName: "shared",
          outputName: "network_id",
        },
        {
          consumerWorkspacePath: "apps/api/infra",
          producerWorkspacePath: "infra/shared",
          moduleName: "shared_alias",
          outputName: "subnet_ids",
        },
      ],
    })

    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({
      runGroupId: transientRunGroup.id,
      producerEnvironmentName: "production",
      producerWorkspacePath: "infra/shared",
      stateSerial: 7,
      stateFingerprint: "state-fingerprint",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      outputNames: ["network_id", "subnet_ids"],
    })
    expect(await db.select().from(runGroupSharedOutputBindings)).toHaveLength(1)

    const resolution = await resolveBoundManagedSharedOutput({
      runGroupId: transientRunGroup.id,
      consumerWorkspacePath: "apps/api/infra",
      producerOrgId: producer.orgId,
      producerRepositoryId: bindings[0].producerRepositoryId,
      producerWorkspacePath: "infra/shared",
    })
    expect(resolution?.stateVersion.id).toBe(bindings[0].stateVersionId)

    await db
      .update(workspaces)
      .set({ status: "destroying" })
      .where(eq(workspaces.id, resolution!.workspace.id))
    expect(
      await resolveBoundManagedSharedOutput({
        runGroupId: transientRunGroup.id,
        consumerWorkspacePath: "apps/api/infra",
        producerOrgId: producer.orgId,
        producerRepositoryId: bindings[0].producerRepositoryId,
        producerWorkspacePath: "infra/shared",
      }),
    ).toMatchObject({ stateVersion: { id: bindings[0].stateVersionId } })

    await db
      .update(stateVersions)
      .set({ md5: "changed-fingerprint" })
      .where(eq(stateVersions.id, bindings[0].stateVersionId))
    await expect(
      resolveBoundManagedSharedOutput({
        runGroupId: transientRunGroup.id,
        consumerWorkspacePath: "apps/api/infra",
        producerOrgId: producer.orgId,
        producerRepositoryId: bindings[0].producerRepositoryId,
        producerWorkspacePath: "infra/shared",
      }),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_SNAPSHOT",
      message: expect.stringContaining("Rescan the transient run"),
    })
  })

  test("fails closed when a transient dependency requests a sensitive snapshot value", async () => {
    const producer = await createNamedProducer()
    await publishManagedSharedOutputSnapshotForApply({
      ...producer,
      workspacePath: "infra/shared",
    })
    const consumerRunGroupId = await createTransientConsumer(producer)

    await expect(
      bindManagedSharedOutputSnapshots({
        runGroupId: consumerRunGroupId,
        orgId: producer.orgId,
        repo: producer.repo,
        environmentKind: "transient",
        selectedWorkspacePaths: ["apps/api/infra"],
        references: [
          {
            consumerWorkspacePath: "apps/api/infra",
            producerWorkspacePath: "infra/shared",
            moduleName: "shared",
            outputName: "database_password",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "SENSITIVE_SNAPSHOT_OUTPUT",
    } satisfies Partial<ManagedSharedOutputError>)
  })

  test("fails with an actionable diagnostic when no managed snapshot exists", async () => {
    const producer = await createNamedProducer()
    const consumerRunGroupId = await createTransientConsumer(producer)

    await expect(
      bindManagedSharedOutputSnapshots({
        runGroupId: consumerRunGroupId,
        orgId: producer.orgId,
        repo: producer.repo,
        environmentKind: "transient",
        selectedWorkspacePaths: ["apps/api/infra"],
        references: [
          {
            consumerWorkspacePath: "apps/api/infra",
            producerWorkspacePath: "infra/missing",
            moduleName: "missing",
            outputName: "network_id",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "MISSING_SNAPSHOT" })
  })

  test("rejects a snapshot when producer state advances without publication", async () => {
    const producer = await createNamedProducer()
    await publishManagedSharedOutputSnapshotForApply({
      ...producer,
      workspacePath: "infra/shared",
    })
    await db.update(workspaces).set({ currentStateVersionId: null })
    const consumerRunGroupId = await createTransientConsumer(producer)

    await expect(
      bindManagedSharedOutputSnapshots({
        runGroupId: consumerRunGroupId,
        orgId: producer.orgId,
        repo: producer.repo,
        environmentKind: "transient",
        selectedWorkspacePaths: ["apps/api/infra"],
        references: [
          {
            consumerWorkspacePath: "apps/api/infra",
            producerWorkspacePath: "infra/shared",
            moduleName: "shared",
            outputName: "network_id",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "STALE_SNAPSHOT" })
  })

  test("rejects a transient context whose stable repository binding changed", async () => {
    const producer = await createNamedProducer()
    const consumerRunGroupId = await createTransientConsumer(producer)
    await db
      .update(repositories)
      .set({ installationId: 999 })
      .where(eq(repositories.orgId, producer.orgId))

    await expect(
      bindManagedSharedOutputSnapshots({
        runGroupId: consumerRunGroupId,
        orgId: producer.orgId,
        repo: producer.repo,
        environmentKind: "transient",
        selectedWorkspacePaths: ["apps/api/infra"],
        references: [
          {
            consumerWorkspacePath: "apps/api/infra",
            producerWorkspacePath: "infra/shared",
            moduleName: "shared",
            outputName: "network_id",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED_SNAPSHOT",
      message: expect.stringContaining("Reconnect the repository"),
    })
  })
})
