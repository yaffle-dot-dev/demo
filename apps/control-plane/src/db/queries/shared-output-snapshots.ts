import { and, desc, eq, max, sql } from "drizzle-orm"

import type { SharedOutputValue } from "@yaffle/shared"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { runGroupSharedOutputBindings, sharedOutputSnapshots, workspaces } from "../schema.ts"

export type SharedOutputSnapshot = typeof sharedOutputSnapshots.$inferSelect
export type RunGroupSharedOutputBinding = typeof runGroupSharedOutputBindings.$inferSelect

export class SharedOutputBindingStaleError extends Error {
  constructor() {
    super("Managed shared output snapshot became stale before it could be pinned")
    this.name = "SharedOutputBindingStaleError"
  }
}

export async function publishSharedOutputSnapshot(values: {
  orgId: string
  repositoryId: string
  repo: string
  workspaceId: string
  workspacePath: string
  environmentName: string
  sourceRevision: string
  sourceRef: string | null
  stateVersionId: string
  stateSerial: number
  stateFingerprint: string
  outputs: Record<string, SharedOutputValue>
}): Promise<SharedOutputSnapshot> {
  return withDbSpan("insert", "shared_output_snapshots", async () =>
    db.transaction(async (tx) => {
      const scope = [
        values.orgId,
        values.repositoryId,
        values.environmentName,
        values.workspacePath,
      ].join(":")
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`)

      const existing = await tx
        .select()
        .from(sharedOutputSnapshots)
        .where(
          and(
            eq(sharedOutputSnapshots.stateVersionId, values.stateVersionId),
            eq(sharedOutputSnapshots.sourceRevision, values.sourceRevision),
          ),
        )
        .limit(1)
      if (existing[0]) {
        return existing[0]
      }

      const [latest] = await tx
        .select({ publicationVersion: max(sharedOutputSnapshots.publicationVersion) })
        .from(sharedOutputSnapshots)
        .where(
          and(
            eq(sharedOutputSnapshots.orgId, values.orgId),
            eq(sharedOutputSnapshots.repositoryId, values.repositoryId),
            eq(sharedOutputSnapshots.environmentName, values.environmentName),
            eq(sharedOutputSnapshots.workspacePath, values.workspacePath),
          ),
        )

      const [published] = await tx
        .insert(sharedOutputSnapshots)
        .values({
          ...values,
          values: values.outputs,
          publicationVersion: (latest?.publicationVersion ?? 0) + 1,
        })
        .returning()
      return published
    }),
  )
}

export async function listManagedSharedOutputSnapshots(values: {
  orgId: string
  repositoryId: string
  workspacePath: string
  environmentName: string
}): Promise<SharedOutputSnapshot[]> {
  return withDbSpan("select", "shared_output_snapshots", async () =>
    db
      .select()
      .from(sharedOutputSnapshots)
      .where(
        and(
          eq(sharedOutputSnapshots.orgId, values.orgId),
          eq(sharedOutputSnapshots.repositoryId, values.repositoryId),
          eq(sharedOutputSnapshots.workspacePath, values.workspacePath),
          eq(sharedOutputSnapshots.environmentName, values.environmentName),
        ),
      )
      .orderBy(
        desc(sharedOutputSnapshots.publishedAt),
        desc(sharedOutputSnapshots.publicationVersion),
      ),
  )
}

export async function bindRunGroupSharedOutput(values: {
  runGroupId: string
  consumerWorkspacePath: string
  moduleName: string
  snapshot: SharedOutputSnapshot
  outputNames: string[]
}): Promise<RunGroupSharedOutputBinding> {
  return withDbSpan("insert", "run_group_shared_output_bindings", async () =>
    db.transaction(async (tx) => {
      const [producerWorkspace] = await tx
        .select({
          currentStateVersionId: workspaces.currentStateVersionId,
          status: workspaces.status,
        })
        .from(workspaces)
        .where(eq(workspaces.id, values.snapshot.workspaceId))
        .for("update")
        .limit(1)
      if (
        producerWorkspace?.status !== "active" ||
        producerWorkspace.currentStateVersionId !== values.snapshot.stateVersionId
      ) {
        throw new SharedOutputBindingStaleError()
      }

      const outputNames = [...new Set(values.outputNames)].sort()
      const [inserted] = await tx
        .insert(runGroupSharedOutputBindings)
        .values({
          runGroupId: values.runGroupId,
          consumerWorkspacePath: values.consumerWorkspacePath,
          moduleName: values.moduleName,
          snapshotId: values.snapshot.id,
          producerOrgId: values.snapshot.orgId,
          producerRepositoryId: values.snapshot.repositoryId,
          producerRepo: values.snapshot.repo,
          producerWorkspacePath: values.snapshot.workspacePath,
          producerEnvironmentName: values.snapshot.environmentName,
          stateVersionId: values.snapshot.stateVersionId,
          stateSerial: values.snapshot.stateSerial,
          stateFingerprint: values.snapshot.stateFingerprint,
          sourceRevision: values.snapshot.sourceRevision,
          outputNames,
        })
        .onConflictDoNothing()
        .returning()
      if (inserted) {
        return inserted
      }

      const [existing] = await tx
        .select()
        .from(runGroupSharedOutputBindings)
        .where(
          and(
            eq(runGroupSharedOutputBindings.runGroupId, values.runGroupId),
            eq(runGroupSharedOutputBindings.consumerWorkspacePath, values.consumerWorkspacePath),
            eq(runGroupSharedOutputBindings.producerRepositoryId, values.snapshot.repositoryId),
            eq(runGroupSharedOutputBindings.producerWorkspacePath, values.snapshot.workspacePath),
          ),
        )
        .limit(1)
      if (
        !existing ||
        existing.snapshotId !== values.snapshot.id ||
        JSON.stringify(existing.outputNames) !== JSON.stringify(outputNames)
      ) {
        throw new Error("Shared output binding is already pinned to a different snapshot")
      }
      return existing
    }),
  )
}

export async function findRunGroupSharedOutputBinding(values: {
  runGroupId: string
  consumerWorkspacePath: string
  producerOrgId: string
  producerRepositoryId: string
  producerWorkspacePath: string
}): Promise<RunGroupSharedOutputBinding | undefined> {
  return withDbSpan("select", "run_group_shared_output_bindings", async () => {
    const [binding] = await db
      .select()
      .from(runGroupSharedOutputBindings)
      .where(
        and(
          eq(runGroupSharedOutputBindings.runGroupId, values.runGroupId),
          eq(runGroupSharedOutputBindings.consumerWorkspacePath, values.consumerWorkspacePath),
          eq(runGroupSharedOutputBindings.producerOrgId, values.producerOrgId),
          eq(runGroupSharedOutputBindings.producerRepositoryId, values.producerRepositoryId),
          eq(runGroupSharedOutputBindings.producerWorkspacePath, values.producerWorkspacePath),
        ),
      )
      .limit(1)
    return binding
  })
}

export async function findSharedOutputSnapshotById(
  id: string,
): Promise<SharedOutputSnapshot | undefined> {
  return withDbSpan("select", "shared_output_snapshots", async () => {
    const [snapshot] = await db
      .select()
      .from(sharedOutputSnapshots)
      .where(eq(sharedOutputSnapshots.id, id))
      .limit(1)
    return snapshot
  })
}

export async function listRunGroupSharedOutputBindings(values: {
  runGroupId: string
  consumerWorkspacePath: string
}): Promise<RunGroupSharedOutputBinding[]> {
  return withDbSpan("select", "run_group_shared_output_bindings", async () =>
    db
      .select()
      .from(runGroupSharedOutputBindings)
      .where(
        and(
          eq(runGroupSharedOutputBindings.runGroupId, values.runGroupId),
          eq(runGroupSharedOutputBindings.consumerWorkspacePath, values.consumerWorkspacePath),
        ),
      ),
  )
}
