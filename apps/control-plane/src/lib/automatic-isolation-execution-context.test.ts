import { describe, expect, test } from "@yaffle/test"
import {
  computeAutomaticIsolationArtifactHash,
  type AutomaticIsolationArtifactManifest,
} from "@yaffle/shared"

import { validateAutomaticIsolationExecutionContext } from "./automatic-isolation-execution-context.ts"

function manifest(
  overrides: Partial<AutomaticIsolationArtifactManifest> = {},
): AutomaticIsolationArtifactManifest {
  const value = {
    contractVersion: 1 as const,
    sourceRevision: "0123456789abcdef",
    identity: {
      organizationId: "org-1",
      repositoryId: "987654321",
      workspacePath: "infra",
      environmentKind: "transient" as const,
      environmentName: "pr-42",
    },
    suffix: "0123456789",
    strategyRevision: "local-file-filename-v1",
    providerLocks: [],
    transformations: [],
    files: [],
    ...overrides,
  }
  const { artifactHash: _artifactHash, ...withoutHash } = value
  return {
    ...withoutHash,
    artifactHash: computeAutomaticIsolationArtifactHash(withoutHash),
  }
}

const baseInput = {
  orgId: "org-1",
  repositoryId: "987654321",
  workspacePath: "infra",
  environmentKind: "transient" as const,
  environmentName: "pr-42",
  sourceRevision: "0123456789abcdef",
  automaticPreviewIsolation: true,
  scanResult: {
    workspaceArtifactSha256: "a".repeat(64),
    automaticIsolationArtifacts: [manifest()],
  },
}

describe("validateAutomaticIsolationExecutionContext", () => {
  test("binds a verified manifest and archive digest to transient execution", () => {
    expect(validateAutomaticIsolationExecutionContext(baseInput)).toMatchObject({
      ok: true,
      automaticIsolationRequired: true,
      workspaceArtifactSha256: "a".repeat(64),
      automaticIsolationManifest: { artifactHash: manifest().artifactHash },
    })
  })

  test("fails closed for missing digests, manifests, and mismatched identities", () => {
    const cases = [
      {
        name: "missing digest",
        input: { ...baseInput, scanResult: { automaticIsolationArtifacts: [manifest()] } },
        code: "WORKSPACE_ARTIFACT_DIGEST_MISSING",
      },
      {
        name: "missing manifest",
        input: {
          ...baseInput,
          scanResult: { workspaceArtifactSha256: "a".repeat(64) },
        },
        code: "AUTOMATIC_ISOLATION_ARTIFACT_MISSING",
      },
      {
        name: "foreign organization",
        input: {
          ...baseInput,
          scanResult: {
            workspaceArtifactSha256: "a".repeat(64),
            automaticIsolationArtifacts: [
              manifest({ identity: { ...manifest().identity, organizationId: "org-2" } }),
            ],
          },
        },
        code: "AUTOMATIC_ISOLATION_ARTIFACT_MISMATCH",
      },
      {
        name: "tampered manifest",
        input: {
          ...baseInput,
          scanResult: {
            workspaceArtifactSha256: "a".repeat(64),
            automaticIsolationArtifacts: [
              { ...manifest(), sourceRevision: "tampered-without-rehashing" },
            ],
          },
        },
        code: "AUTOMATIC_ISOLATION_ARTIFACT_MISMATCH",
      },
    ]

    for (const testCase of cases) {
      expect(
        validateAutomaticIsolationExecutionContext(testCase.input),
        testCase.name,
      ).toMatchObject({ ok: false, code: testCase.code })
    }
  })

  test("rejects an isolation manifest for execution that did not opt in", () => {
    expect(
      validateAutomaticIsolationExecutionContext({
        ...baseInput,
        automaticPreviewIsolation: false,
      }),
    ).toMatchObject({
      ok: false,
      code: "AUTOMATIC_ISOLATION_ARTIFACT_MISMATCH",
    })
  })
})
