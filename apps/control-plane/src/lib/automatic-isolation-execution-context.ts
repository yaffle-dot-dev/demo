import {
  computeAutomaticIsolationArtifactHash,
  type AutomaticIsolationArtifactManifest,
} from "@yaffle/shared"

export type AutomaticIsolationExecutionContextErrorCode =
  | "WORKSPACE_ARTIFACT_DIGEST_MISSING"
  | "AUTOMATIC_ISOLATION_ARTIFACT_MISSING"
  | "AUTOMATIC_ISOLATION_ARTIFACT_MISMATCH"

export type AutomaticIsolationExecutionContextValidation =
  | {
      ok: true
      automaticIsolationRequired: boolean
      workspaceArtifactSha256: string
      automaticIsolationManifest?: AutomaticIsolationArtifactManifest
    }
  | {
      ok: false
      code: AutomaticIsolationExecutionContextErrorCode
      message: string
    }

export function validateAutomaticIsolationExecutionContext(values: {
  orgId: string
  repositoryId: string
  workspacePath: string
  environmentKind: "named" | "transient"
  environmentName: string
  sourceRevision: string
  automaticPreviewIsolation: boolean
  scanResult?: {
    workspaceArtifactSha256?: string
    automaticIsolationArtifacts?: AutomaticIsolationArtifactManifest[]
  }
}): AutomaticIsolationExecutionContextValidation {
  const automaticIsolationRequired =
    values.environmentKind === "transient" && values.automaticPreviewIsolation
  const digest = values.scanResult?.workspaceArtifactSha256
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
    return {
      ok: false,
      code: "WORKSPACE_ARTIFACT_DIGEST_MISSING",
      message: "Workspace artifact is not bound to a content digest",
    }
  }

  const matchingArtifacts = (values.scanResult?.automaticIsolationArtifacts ?? []).filter(
    (artifact) => artifact.identity.workspacePath === values.workspacePath,
  )
  if (automaticIsolationRequired && matchingArtifacts.length === 0) {
    return {
      ok: false,
      code: "AUTOMATIC_ISOLATION_ARTIFACT_MISSING",
      message: "Automatically isolated workspace is missing its verified manifest",
    }
  }
  if (
    matchingArtifacts.length > 1 ||
    (!automaticIsolationRequired && matchingArtifacts.length > 0)
  ) {
    return {
      ok: false,
      code: "AUTOMATIC_ISOLATION_ARTIFACT_MISMATCH",
      message: "Automatic isolation artifact does not match the execution snapshot",
    }
  }

  const automaticIsolationManifest = matchingArtifacts[0]
  if (automaticIsolationManifest) {
    const { artifactHash, ...manifestWithoutHash } = automaticIsolationManifest
    const manifestMatchesSnapshot =
      computeAutomaticIsolationArtifactHash(manifestWithoutHash) === artifactHash &&
      automaticIsolationManifest.identity.organizationId === values.orgId &&
      automaticIsolationManifest.identity.repositoryId === values.repositoryId &&
      automaticIsolationManifest.identity.environmentKind === "transient" &&
      automaticIsolationManifest.identity.environmentName === values.environmentName &&
      automaticIsolationManifest.sourceRevision === values.sourceRevision
    if (!manifestMatchesSnapshot) {
      return {
        ok: false,
        code: "AUTOMATIC_ISOLATION_ARTIFACT_MISMATCH",
        message: "Automatic isolation artifact does not match the execution snapshot",
      }
    }
  }

  return {
    ok: true,
    automaticIsolationRequired,
    workspaceArtifactSha256: digest,
    automaticIsolationManifest,
  }
}
