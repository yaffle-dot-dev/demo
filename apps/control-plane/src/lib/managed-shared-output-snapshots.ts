import {
  SHARED_OUTPUT_SNAPSHOT_CONTRACT_VERSION,
  environmentName,
  publicationVersion,
  stateSerial,
  stateVersionIdentity,
  type SharedOutputSnapshotV1,
  type WorkspaceModuleOutputReference,
} from "@yaffle/shared"

import {
  bindRunGroupSharedOutput,
  findSharedOutputSnapshotById,
  findRunGroupSharedOutputBinding,
  listManagedSharedOutputSnapshots,
  listRunGroupSharedOutputBindings,
  publishSharedOutputSnapshot,
  SharedOutputBindingStaleError,
  type RunGroupSharedOutputBinding,
  type SharedOutputSnapshot,
} from "../db/queries/shared-output-snapshots.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { findRepoByGithubId } from "../db/queries/repositories.ts"
import { findRunGroupById } from "../db/queries/run-groups.ts"
import { findStateVersionById, getCurrentStateVersion } from "../db/queries/state-versions.ts"
import { deploymentBelongsToRunGroup } from "../db/queries/workspace-deployments.ts"
import { findWorkspaceById, findWorkspaceByIdentity } from "../db/queries/workspaces.ts"
import { findExecutionSnapshotWorkspace } from "./execution-snapshot.ts"
import { selectSharedOutputSnapshotValues } from "./output-selection.ts"

export class ManagedSharedOutputError extends Error {
  constructor(
    public readonly code:
      | "AMBIGUOUS_SNAPSHOT"
      | "INCOMPATIBLE_SNAPSHOT"
      | "MISSING_SNAPSHOT"
      | "SENSITIVE_SNAPSHOT_OUTPUT"
      | "STALE_SNAPSHOT"
      | "UNAUTHORIZED_SNAPSHOT",
    message: string,
  ) {
    super(message)
    this.name = "ManagedSharedOutputError"
  }
}

function opaqueIdentity(prefix: "sos" | "statev", id: string): string {
  return `${prefix}_${id.replaceAll("-", "")}`
}

export function serializeManagedSharedOutputSnapshot(
  snapshot: SharedOutputSnapshot,
  producer: { organization: string; repository: string },
): SharedOutputSnapshotV1 {
  return {
    contractVersion: SHARED_OUTPUT_SNAPSHOT_CONTRACT_VERSION,
    snapshotId: opaqueIdentity("sos", snapshot.id),
    publicationVersion: publicationVersion(snapshot.publicationVersion),
    producer: {
      organizationId: snapshot.orgId,
      organization: producer.organization,
      repositoryId: snapshot.repositoryId,
      repository: producer.repository,
      workspace: snapshot.workspacePath,
      environment: {
        class: "named_managed",
        name: environmentName(snapshot.environmentName),
      },
    },
    sourceRevision: {
      vcs: "git",
      commitSha: snapshot.sourceRevision,
      ...(snapshot.sourceRef ? { ref: snapshot.sourceRef } : {}),
    },
    state: {
      identity: stateVersionIdentity(opaqueIdentity("statev", snapshot.stateVersionId)),
      serial: stateSerial(snapshot.stateSerial),
    },
    publishedAt: snapshot.publishedAt.toISOString(),
    values: structuredClone(snapshot.values),
  }
}

async function publishManagedSharedOutputSnapshot(values: {
  runGroupId: string
  deploymentId: string
  workspacePath: string
  exactStateCapability?: { runId: string; jobId: string }
}): Promise<SharedOutputSnapshotV1 | null> {
  if (!(await deploymentBelongsToRunGroup(values.deploymentId, values.runGroupId))) {
    return null
  }

  const runGroup = await findRunGroupById(values.runGroupId)
  if (!runGroup?.executionSnapshot || runGroup.environmentKind !== "named") {
    return null
  }
  const workspaceSnapshot = findExecutionSnapshotWorkspace(
    runGroup.executionSnapshot,
    values.workspacePath,
  )
  if (!workspaceSnapshot) {
    return null
  }

  const [org, repository, workspace] = await Promise.all([
    findOrgById(runGroup.orgId),
    findRepoByGithubId(runGroup.executionSnapshot.source.repositoryId),
    findWorkspaceByIdentity(
      runGroup.orgId,
      runGroup.repo,
      values.workspacePath,
      "named",
      runGroup.environmentName,
    ),
  ])
  if (
    !org ||
    !repository ||
    !workspace ||
    workspace.status !== "active" ||
    repository.githubId !== runGroup.executionSnapshot.source.repositoryId ||
    repository.orgId !== runGroup.orgId ||
    repository.name !== runGroup.repo ||
    repository.installationId !== runGroup.executionSnapshot.source.installationId
  ) {
    throw new ManagedSharedOutputError(
      "UNAUTHORIZED_SNAPSHOT",
      `Cannot authenticate the managed producer for workspace ${values.workspacePath}. Reconnect the repository and retry the named convergence.`,
    )
  }

  const currentState = await getCurrentStateVersion(workspace.id)
  if (
    !currentState ||
    currentState.status !== "finalized" ||
    (values.exactStateCapability &&
      (currentState.runId !== values.exactStateCapability.runId ||
        currentState.jobId !== values.exactStateCapability.jobId))
  ) {
    throw new ManagedSharedOutputError(
      "INCOMPATIBLE_SNAPSHOT",
      `Workspace ${values.workspacePath} did not finalize state for this exact apply. Retry after the state upload completes.`,
    )
  }

  const snapshot = await publishSharedOutputSnapshot({
    orgId: org.id,
    repositoryId: repository.id,
    repo: repository.name,
    workspaceId: workspace.id,
    workspacePath: workspace.workspacePath,
    environmentName: workspace.environmentName,
    sourceRevision: runGroup.executionSnapshot.source.commitSha,
    sourceRef: runGroup.executionSnapshot.source.ref,
    stateVersionId: currentState.id,
    stateSerial: currentState.serial,
    stateFingerprint: currentState.md5,
    outputs: selectSharedOutputSnapshotValues(
      currentState.outputs as Record<string, unknown> | null,
      workspaceSnapshot.outputs,
    ),
  })

  return serializeManagedSharedOutputSnapshot(snapshot, {
    organization: org.slug,
    repository: repository.name,
  })
}

export async function publishManagedSharedOutputSnapshotForApply(values: {
  runGroupId: string
  deploymentId: string
  runId: string
  jobId: string
  workspacePath: string
}): Promise<SharedOutputSnapshotV1 | null> {
  return publishManagedSharedOutputSnapshot({
    runGroupId: values.runGroupId,
    deploymentId: values.deploymentId,
    workspacePath: values.workspacePath,
    exactStateCapability: { runId: values.runId, jobId: values.jobId },
  })
}

export async function publishManagedSharedOutputSnapshotForConvergence(values: {
  runGroupId: string
  deploymentId: string
  workspacePath: string
}): Promise<SharedOutputSnapshotV1 | null> {
  return publishManagedSharedOutputSnapshot(values)
}

function selectOneProducerSnapshot(
  snapshots: SharedOutputSnapshot[],
  producerWorkspacePath: string,
): SharedOutputSnapshot {
  if (snapshots.length === 0) {
    throw new ManagedSharedOutputError(
      "MISSING_SNAPSHOT",
      `No managed shared output snapshot is available for workspace ${producerWorkspacePath}. Apply its named environment first.`,
    )
  }

  return snapshots[0]
}

export async function bindManagedSharedOutputSnapshots(values: {
  runGroupId: string
  orgId: string
  repo: string
  environmentKind: "named" | "transient"
  selectedWorkspacePaths: string[]
  references: WorkspaceModuleOutputReference[]
}): Promise<RunGroupSharedOutputBinding[]> {
  const selected = new Set(values.selectedWorkspacePaths)
  const externalReferences = values.references.filter(
    (reference) => !selected.has(reference.producerWorkspacePath),
  )
  if (externalReferences.length === 0) {
    return []
  }
  if (values.environmentKind !== "transient") {
    throw new ManagedSharedOutputError(
      "UNAUTHORIZED_SNAPSHOT",
      "Only transient managed environments may consume named managed snapshots through fallback resolution",
    )
  }

  const runGroup = await findRunGroupById(values.runGroupId)
  const repository = runGroup?.executionSnapshot
    ? await findRepoByGithubId(runGroup.executionSnapshot.source.repositoryId)
    : undefined
  if (
    !runGroup?.executionSnapshot ||
    runGroup.orgId !== values.orgId ||
    runGroup.repo !== values.repo ||
    runGroup.executionSnapshot.environment.kind !== "transient" ||
    !repository ||
    repository.orgId !== values.orgId ||
    repository.name !== values.repo ||
    repository.githubId !== runGroup.executionSnapshot.source.repositoryId ||
    repository.installationId !== runGroup.executionSnapshot.source.installationId
  ) {
    throw new ManagedSharedOutputError(
      "UNAUTHORIZED_SNAPSHOT",
      "The transient execution context is not bound to the producer repository. Reconnect the repository and rescan the run.",
    )
  }

  const grouped = new Map<string, WorkspaceModuleOutputReference[]>()
  for (const reference of externalReferences) {
    const key = `${reference.consumerWorkspacePath}\0${reference.producerWorkspacePath}`
    grouped.set(key, [...(grouped.get(key) ?? []), reference])
  }

  const bindings: RunGroupSharedOutputBinding[] = []
  for (const references of grouped.values()) {
    const reference = references[0]
    const producerIdentity = runGroup.executionSnapshot.managedOutputProducers?.find(
      (producer) => producer.path === reference.producerWorkspacePath,
    )
    if (!producerIdentity || producerIdentity.environmentNames.length !== 1) {
      throw new ManagedSharedOutputError(
        "AMBIGUOUS_SNAPSHOT",
        `Workspace ${reference.producerWorkspacePath} must belong to exactly one named environment before a transient run can resolve its outputs`,
      )
    }
    const snapshots = await listManagedSharedOutputSnapshots({
      orgId: values.orgId,
      repositoryId: repository.id,
      workspacePath: reference.producerWorkspacePath,
      environmentName: producerIdentity.environmentNames[0],
    })
    const snapshot = selectOneProducerSnapshot(snapshots, reference.producerWorkspacePath)
    const [state, producerWorkspace] = await Promise.all([
      findStateVersionById(snapshot.stateVersionId),
      findWorkspaceById(snapshot.workspaceId),
    ])
    if (
      !state ||
      state.status !== "finalized" ||
      state.workspaceId !== snapshot.workspaceId ||
      state.serial !== snapshot.stateSerial ||
      state.md5 !== snapshot.stateFingerprint
    ) {
      throw new ManagedSharedOutputError(
        "INCOMPATIBLE_SNAPSHOT",
        `Snapshot ${opaqueIdentity("sos", snapshot.id)} for workspace ${reference.producerWorkspacePath} no longer matches its immutable state identity. Converge the named producer and rescan the transient run.`,
      )
    }
    if (
      !producerWorkspace ||
      producerWorkspace.status !== "active" ||
      producerWorkspace.currentStateVersionId !== snapshot.stateVersionId
    ) {
      throw new ManagedSharedOutputError(
        "STALE_SNAPSHOT",
        `Snapshot ${opaqueIdentity("sos", snapshot.id)} is stale for workspace ${reference.producerWorkspacePath}; converge the named producer before retrying the transient run`,
      )
    }

    const outputNames = [...new Set(references.map((item) => item.outputName))].sort()
    for (const outputName of outputNames) {
      const output = snapshot.values[outputName]
      if (!output) {
        throw new ManagedSharedOutputError(
          "UNAUTHORIZED_SNAPSHOT",
          `Workspace ${reference.consumerWorkspacePath} references output ${outputName}, but snapshot ${opaqueIdentity("sos", snapshot.id)} does not authorize it. Declare the output on ${reference.producerWorkspacePath}, converge the named producer, and retry.`,
        )
      }
      if (output.sensitive) {
        throw new ManagedSharedOutputError(
          "SENSITIVE_SNAPSHOT_OUTPUT",
          `Workspace ${reference.consumerWorkspacePath} cannot consume sensitive output ${outputName} from ${reference.producerWorkspacePath}. Export only a secret identifier or ARN.`,
        )
      }
    }

    try {
      bindings.push(
        await bindRunGroupSharedOutput({
          runGroupId: values.runGroupId,
          consumerWorkspacePath: reference.consumerWorkspacePath,
          moduleName: reference.moduleName,
          snapshot,
          outputNames,
        }),
      )
    } catch (error) {
      if (error instanceof SharedOutputBindingStaleError) {
        throw new ManagedSharedOutputError(
          "STALE_SNAPSHOT",
          `Snapshot ${opaqueIdentity("sos", snapshot.id)} became stale while pinning; retry after the named producer finishes converging`,
        )
      }
      throw error
    }
  }
  return bindings
}

export async function resolveBoundManagedSharedOutput(values: {
  runGroupId: string
  consumerWorkspacePath: string
  producerOrgId: string
  producerRepositoryId: string
  producerWorkspacePath: string
}): Promise<
  | {
      binding: RunGroupSharedOutputBinding
      snapshot: SharedOutputSnapshot
      workspace: NonNullable<Awaited<ReturnType<typeof findWorkspaceById>>>
      stateVersion: NonNullable<Awaited<ReturnType<typeof findStateVersionById>>>
    }
  | undefined
> {
  const binding = await findRunGroupSharedOutputBinding(values)
  if (!binding) {
    return undefined
  }

  const [snapshot, stateVersion] = await Promise.all([
    findSharedOutputSnapshotById(binding.snapshotId),
    findStateVersionById(binding.stateVersionId),
  ])
  const producerWorkspace = stateVersion
    ? await findWorkspaceById(stateVersion.workspaceId)
    : undefined
  if (
    !snapshot ||
    !producerWorkspace ||
    !stateVersion ||
    stateVersion.status !== "finalized" ||
    producerWorkspace.orgId !== binding.producerOrgId ||
    snapshot.orgId !== binding.producerOrgId ||
    snapshot.repositoryId !== binding.producerRepositoryId ||
    snapshot.repo !== binding.producerRepo ||
    snapshot.workspaceId !== producerWorkspace.id ||
    snapshot.workspacePath !== binding.producerWorkspacePath ||
    snapshot.environmentName !== binding.producerEnvironmentName ||
    snapshot.stateVersionId !== binding.stateVersionId ||
    snapshot.stateSerial !== binding.stateSerial ||
    snapshot.stateFingerprint !== binding.stateFingerprint ||
    snapshot.sourceRevision !== binding.sourceRevision ||
    producerWorkspace.repo !== snapshot.repo ||
    producerWorkspace.workspacePath !== binding.producerWorkspacePath ||
    producerWorkspace.environmentKind !== "named" ||
    producerWorkspace.environmentName !== binding.producerEnvironmentName ||
    stateVersion.serial !== binding.stateSerial ||
    stateVersion.md5 !== binding.stateFingerprint
  ) {
    throw new ManagedSharedOutputError(
      "INCOMPATIBLE_SNAPSHOT",
      `Pinned snapshot ${opaqueIdentity("sos", binding.snapshotId)} no longer matches its immutable producer state. Rescan the transient run to create a new authorized binding.`,
    )
  }

  return { binding, snapshot, workspace: producerWorkspace, stateVersion }
}

export async function listManagedSharedOutputPins(values: {
  runGroupId: string
  consumerWorkspacePath: string
}): Promise<
  Array<{
    snapshotId: string
    producer: { workspace: string; environment: string }
    sourceRevision: string
    state: { identity: string; serial: number; fingerprint: string }
    outputNames: string[]
  }>
> {
  const bindings = await listRunGroupSharedOutputBindings(values)
  return bindings.map((binding) => ({
    snapshotId: opaqueIdentity("sos", binding.snapshotId),
    producer: {
      workspace: binding.producerWorkspacePath,
      environment: binding.producerEnvironmentName,
    },
    sourceRevision: binding.sourceRevision,
    state: {
      identity: opaqueIdentity("statev", binding.stateVersionId),
      serial: binding.stateSerial,
      fingerprint: binding.stateFingerprint,
    },
    outputNames: binding.outputNames,
  }))
}
