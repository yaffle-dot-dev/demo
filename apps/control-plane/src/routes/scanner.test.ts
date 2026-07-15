import { beforeEach, describe, expect, mock, test } from "@yaffle/test"
import { Hono } from "hono"

import {
  computeAutomaticIsolationArtifactHash,
  type AutomaticIsolationArtifactManifest,
} from "@yaffle/shared"

const mockVerifyScanJobToken = mock(
  async (): Promise<{
    scan_job_id: string
    org_id: string
  } | null> => ({
    scan_job_id: "scan-job-1",
    org_id: "org-1",
  }),
)
const mockFindScanJobById = mock(async () => ({
  orgId: "org-1",
  status: "running",
  runGroupId: "run-group-1",
  automaticIsolationWorkspacePaths: [] as string[],
}))
const mockCompleteScanJob = mock(async () => ({ runGroupId: "run-group-1" }))
const mockFailScanJob = mock(async () => ({ runGroupId: "run-group-1" }))
const mockUpdateRunGroupStatus = mock(async () => undefined)
const mockCompleteRunGroupCheck = mock(async () => undefined)
const mockCompleteRunGroup = mock(async () => undefined)
const mockClaimScanJob = mock(async () => ({ claimed: false }))
const mockHeartbeatScanJob = mock(async () => true)
const mockFindRunGroupById = mock(async () => ({
  orgId: "org-1",
  repo: "widgets",
  environmentKind: "transient",
  environmentName: "pr-42",
  executionSnapshot: {
    version: 1,
    source: {
      owner: "acme",
      repository: "widgets",
      repositoryId: 987654321,
      ref: "refs/heads/feature",
      commitSha: "0123456789abcdef",
    },
    environment: { kind: "transient", name: "pr-42" },
    workspaces: [{ path: "infra", automaticPreviewIsolation: true }],
  },
}))

process.env.YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS = "5"
process.env.YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS = "25"
process.env.YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS = "1"

const { createScannerRoute } = await import("./scanner.ts")

function buildApp(): Hono {
  const app = new Hono()
  const overrides = {
    verifyScanJobToken: mockVerifyScanJobToken,
    claimScanJob: mockClaimScanJob,
    completeScanJob: mockCompleteScanJob,
    failScanJob: mockFailScanJob,
    findScanJobById: mockFindScanJobById,
    heartbeatScanJob: mockHeartbeatScanJob,
    findRunGroupById: mockFindRunGroupById,
    updateRunGroupStatus: mockUpdateRunGroupStatus,
    completeRunGroupCheck: mockCompleteRunGroupCheck,
    completeRunGroup: mockCompleteRunGroup,
    createWorkspaceCache: mock(() => ({
      getUploadUrl: mock(async () => "https://uploads.test/workspace"),
    })),
  } as unknown as Parameters<typeof createScannerRoute>[0]
  app.route("/api/scanner", createScannerRoute(overrides))
  return app
}

function requestBody(body: unknown): Request {
  return new Request("http://localhost/api/scanner/complete", {
    method: "POST",
    headers: {
      authorization: "Bearer scanner-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

const baseResult = {
  graph: { workspaces: ["infra"], edges: [] },
  executionOrder: ["infra"],
  workspaceS3Key: "run-groups/run-group-1/workspace.tar.gz",
  workspaceArtifactSha256: "a".repeat(64),
}

function isolationArtifact(): AutomaticIsolationArtifactManifest {
  const manifest = {
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
    naming: {
      separator: "-",
      maxLength: 63,
      allowedPattern: "^[a-z0-9-]+$",
      collisionScope: "organization_repository_workspace_environment" as const,
    },
    providerLocks: [
      {
        source: "registry.opentofu.org/hashicorp/local",
        version: "2.5.3",
        hashes: ["h1:test"],
      },
    ],
    transformations: [
      {
        resourceAddress: "local_file.preview",
        attribute: "filename",
        sourceFile: "infra/main.tf",
        sourceExpression: "preview",
        strategyRevision: "local-file-filename-v1",
      },
    ],
    files: [{ path: "yaffle_isolation_override.tf.json", sha256: "b".repeat(64) }],
  }
  return { ...manifest, artifactHash: computeAutomaticIsolationArtifactHash(manifest) }
}

describe("scanner completion", () => {
  beforeEach(() => {
    mockVerifyScanJobToken.mockReset()
    mockVerifyScanJobToken.mockImplementation(async () => ({
      scan_job_id: "scan-job-1",
      org_id: "org-1",
    }))
    mockFindScanJobById.mockReset()
    mockFindScanJobById.mockImplementation(async () => ({
      status: "running",
      orgId: "org-1",
      runGroupId: "run-group-1",
      automaticIsolationWorkspacePaths: [],
    }))
    mockCompleteScanJob.mockReset()
    mockCompleteScanJob.mockImplementation(async () => ({ runGroupId: "run-group-1" }))
    mockFailScanJob.mockReset()
    mockFailScanJob.mockImplementation(async () => ({ runGroupId: "run-group-1" }))
    mockUpdateRunGroupStatus.mockReset()
    mockCompleteRunGroupCheck.mockReset()
    mockCompleteRunGroup.mockReset()
    mockClaimScanJob.mockReset()
    mockClaimScanJob.mockImplementation(async () => ({ claimed: false }))
    mockHeartbeatScanJob.mockReset()
    mockHeartbeatScanJob.mockImplementation(async () => true)
    mockFindRunGroupById.mockReset()
    mockFindRunGroupById.mockImplementation(async () => ({
      orgId: "org-1",
      repo: "widgets",
      environmentKind: "transient",
      environmentName: "pr-42",
      executionSnapshot: {
        version: 1,
        source: {
          owner: "acme",
          repository: "widgets",
          repositoryId: 987654321,
          ref: "refs/heads/feature",
          commitSha: "0123456789abcdef",
        },
        environment: { kind: "transient", name: "pr-42" },
        workspaces: [{ path: "infra", automaticPreviewIsolation: true }],
      },
    }))
  })

  test("claims transient isolation context and an immutable run-scoped artifact key", async () => {
    const job = {
      id: "scan-job-1",
      orgId: "org-1",
      runGroupId: "run-group-1",
      orgSlug: "acme",
      repoUrl: "https://github.com/acme/widgets.git",
      ref: "refs/heads/feature",
      headSha: "0123456789abcdef",
      installationToken: null,
      workspacePaths: ["infra"],
      workspaceVariables: {},
      automaticIsolationWorkspacePaths: ["infra"],
    }
    mockFindScanJobById.mockImplementation(async () => ({ ...job, status: "queued" }))
    mockClaimScanJob.mockImplementation(async () => ({ claimed: true, job }))

    const response = await buildApp().fetch(
      new Request("http://localhost/api/scanner/claim", {
        method: "POST",
        headers: { authorization: "Bearer scanner-token" },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceS3Key: "run-groups/run-group-1/workspace.tar.gz",
      automaticIsolationContext: {
        organizationId: "org-1",
        repositoryId: "987654321",
        environmentKind: "transient",
        environmentName: "pr-42",
        sourceRevision: "0123456789abcdef",
      },
    })
  })

  test("creates plan work only after a ready preflight", async () => {
    const response = await buildApp().fetch(requestBody(baseResult))

    expect(response.status).toBe(200)
    expect(mockCompleteScanJob).toHaveBeenCalledTimes(1)
    expect(mockCompleteRunGroup).toHaveBeenCalledTimes(1)
    expect(mockFailScanJob).not.toHaveBeenCalled()
  })

  test("creates plan work for an artifact bound to the immutable execution snapshot", async () => {
    mockFindScanJobById.mockImplementation(async () => ({
      status: "running",
      orgId: "org-1",
      runGroupId: "run-group-1",
      automaticIsolationWorkspacePaths: ["infra"],
    }))

    const response = await buildApp().fetch(
      requestBody({
        ...baseResult,
        automaticIsolationPreflight: {
          status: "ready",
          workspaces: [{ workspacePath: "infra", status: "ready", findings: [] }],
        },
        automaticIsolationArtifacts: [isolationArtifact()],
      }),
    )

    expect(response.status).toBe(200)
    expect(mockCompleteRunGroup).toHaveBeenCalledTimes(1)
    expect(mockFailScanJob).not.toHaveBeenCalled()
  })

  test("fails before planning when an artifact identity does not match the snapshot", async () => {
    mockFindScanJobById.mockImplementation(async () => ({
      status: "running",
      orgId: "org-1",
      runGroupId: "run-group-1",
      automaticIsolationWorkspacePaths: ["infra"],
    }))
    const artifact = isolationArtifact()
    artifact.identity.organizationId = "org-2"
    const { artifactHash: _artifactHash, ...manifestWithoutHash } = artifact
    artifact.artifactHash = computeAutomaticIsolationArtifactHash(manifestWithoutHash)

    const response = await buildApp().fetch(
      requestBody({
        ...baseResult,
        automaticIsolationPreflight: {
          status: "ready",
          workspaces: [{ workspacePath: "infra", status: "ready", findings: [] }],
        },
        automaticIsolationArtifacts: [artifact],
      }),
    )

    expect(response.status).toBe(200)
    expect(mockFailScanJob).toHaveBeenCalledTimes(1)
    expect(mockCompleteRunGroup).not.toHaveBeenCalled()
  })

  test("rejects an artifact key from another run group", async () => {
    const response = await buildApp().fetch(
      requestBody({
        ...baseResult,
        workspaceS3Key: "run-groups/another-run-group/workspace.tar.gz",
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_WORKSPACE_ARTIFACT" },
    })
    expect(mockCompleteScanJob).not.toHaveBeenCalled()
  })

  test("stops before plan work when Cloud review is required", async () => {
    mockFindScanJobById.mockImplementation(async () => ({
      status: "running",
      orgId: "org-1",
      runGroupId: "run-group-1",
      automaticIsolationWorkspacePaths: ["infra"],
    }))

    const response = await buildApp().fetch(
      requestBody({
        ...baseResult,
        workspaceS3Key: undefined,
        automaticIsolationPreflight: {
          status: "review_required",
          workspaces: [
            {
              workspacePath: "infra",
              status: "review_required",
              findings: [
                {
                  code: "resource_review_required",
                  filePath: "infra/main.tf",
                  resourceAddress: "aws_s3_bucket.uploads",
                  message: "Review is required.",
                },
              ],
            },
          ],
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(mockCompleteRunGroup).not.toHaveBeenCalled()
    expect(mockUpdateRunGroupStatus).toHaveBeenCalledWith(
      "run-group-1",
      "isolation_review_required",
      expect.any(Object),
    )
    expect(mockCompleteRunGroupCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "action_required",
        title: "Automatic preview isolation review required",
      }),
    )
  })

  test("fails closed when scanner coverage or statuses are inconsistent", async () => {
    mockFindScanJobById.mockImplementation(async () => ({
      status: "running",
      orgId: "org-1",
      runGroupId: "run-group-1",
      automaticIsolationWorkspacePaths: ["infra"],
    }))

    const response = await buildApp().fetch(
      requestBody({
        ...baseResult,
        automaticIsolationPreflight: {
          status: "ready",
          workspaces: [
            {
              workspacePath: "infra",
              status: "ready",
              findings: [
                {
                  code: "import_not_allowed",
                  filePath: "infra/main.tf",
                  resourceAddress: "aws_s3_bucket.uploads",
                  message: "Imports are not allowed.",
                },
              ],
            },
          ],
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(mockFailScanJob).toHaveBeenCalledTimes(1)
    expect(mockCompleteScanJob).not.toHaveBeenCalled()
    expect(mockCompleteRunGroup).not.toHaveBeenCalled()
  })

  test("rejects unauthorized and oversized callbacks", async () => {
    mockVerifyScanJobToken.mockImplementation(async () => null)
    const unauthorized = await buildApp().fetch(requestBody(baseResult))
    expect(unauthorized.status).toBe(401)

    mockVerifyScanJobToken.mockImplementation(async () => ({
      scan_job_id: "scan-job-1",
      org_id: "org-1",
    }))
    const oversized = await buildApp().fetch(requestBody({ error: "x".repeat(1_000_001) }))
    expect(oversized.status).toBe(413)
  })

  test("rejects every scanner operation when the token organization does not own the job", async () => {
    mockFindScanJobById.mockImplementation(async () => ({
      orgId: "org-2",
      status: "running",
      runGroupId: "run-group-1",
      automaticIsolationWorkspacePaths: [],
    }))

    const app = buildApp()
    const complete = await app.fetch(requestBody(baseResult))
    const claim = await app.fetch(
      new Request("http://localhost/api/scanner/claim", {
        method: "POST",
        headers: { authorization: "Bearer scanner-token" },
      }),
    )
    const heartbeat = await app.fetch(
      new Request("http://localhost/api/scanner/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer scanner-token" },
      }),
    )

    expect([complete.status, claim.status, heartbeat.status]).toEqual([404, 404, 404])
    expect(mockCompleteScanJob).not.toHaveBeenCalled()
    expect(mockFailScanJob).not.toHaveBeenCalled()
    expect(mockClaimScanJob).not.toHaveBeenCalled()
    expect(mockHeartbeatScanJob).not.toHaveBeenCalled()
  })

  test("rejects scanner operations when the token organization does not own the run group", async () => {
    mockFindRunGroupById.mockImplementation(async () => ({
      orgId: "org-2",
      repo: "widgets",
      environmentKind: "transient",
      environmentName: "pr-42",
      executionSnapshot: {
        version: 1,
        source: {
          owner: "acme",
          repository: "widgets",
          repositoryId: 987654321,
          ref: "refs/heads/feature",
          commitSha: "0123456789abcdef",
        },
        environment: { kind: "transient", name: "pr-42" },
        workspaces: [{ path: "infra", automaticPreviewIsolation: true }],
      },
    }))

    const app = buildApp()
    const complete = await app.fetch(requestBody(baseResult))
    const claim = await app.fetch(
      new Request("http://localhost/api/scanner/claim", {
        method: "POST",
        headers: { authorization: "Bearer scanner-token" },
      }),
    )

    expect([complete.status, claim.status]).toEqual([404, 404])
    expect(mockCompleteScanJob).not.toHaveBeenCalled()
    expect(mockClaimScanJob).not.toHaveBeenCalled()
  })

  test("rejects a claim whose source ref does not match the execution snapshot", async () => {
    const job = {
      id: "scan-job-1",
      orgId: "org-1",
      runGroupId: "run-group-1",
      orgSlug: "acme",
      repoUrl: "https://github.com/acme/widgets.git",
      ref: "refs/heads/different",
      headSha: "0123456789abcdef",
      installationToken: null,
      workspacePaths: ["infra"],
      workspaceVariables: {},
      automaticIsolationWorkspacePaths: ["infra"],
    }
    mockFindScanJobById.mockImplementation(async () => ({ ...job, status: "queued" }))

    const response = await buildApp().fetch(
      new Request("http://localhost/api/scanner/claim", {
        method: "POST",
        headers: { authorization: "Bearer scanner-token" },
      }),
    )

    expect(response.status).toBe(409)
    expect(mockClaimScanJob).not.toHaveBeenCalled()
  })
})
