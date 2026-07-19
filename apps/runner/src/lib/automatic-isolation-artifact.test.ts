import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "@yaffle/test"

import {
  automaticIsolationArtifactPaths,
  compileAutomaticIsolationArtifact,
  removeAutomaticIsolationArtifact,
  verifyAutomaticIsolationArtifact,
} from "./automatic-isolation-artifact.ts"

const LOCK_FILE = `
provider "registry.opentofu.org/hashicorp/local" {
  version     = "2.5.3"
  constraints = "2.5.3"
  hashes = [
    "h1:test-lock-hash",
  ]
}
`

const SOURCE = `
terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.3"
    }
  }
}

variable "filename" {
  type = string
}

resource "local_file" "preview" {
  filename = var.filename
  content  = "preview"
}
`

function compile(
  identity: Partial<{
    organizationId: string
    repositoryId: string
    workspacePath: string
    environmentName: string
  }> = {},
) {
  return compileAutomaticIsolationArtifact({
    identity: {
      organizationId: "org-123",
      repositoryId: "987654321",
      workspacePath: "infra",
      environmentKind: "transient",
      environmentName: "pr-42",
      ...identity,
    },
    sourceRevision: "0123456789abcdef",
    files: [
      { path: "infra/main.tf", content: SOURCE },
      { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
    ],
  })
}

describe("compileAutomaticIsolationArtifact", () => {
  test("compiles the exact local_file strategy into a deterministic execution artifact", () => {
    const files = [
      { path: "infra/main.tf", content: SOURCE },
      { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
    ]

    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files,
    })

    expect(result.preflight.status).toBe("ready")
    expect(result.artifact?.manifest).toMatchObject({
      contractVersion: 1,
      sourceRevision: "0123456789abcdef",
      strategyRevision: "local-file-filename-v1",
      providerLocks: [
        {
          source: "registry.opentofu.org/hashicorp/local",
          version: "2.5.3",
          hashes: ["h1:test-lock-hash"],
        },
      ],
      transformations: [
        {
          resourceAddress: "local_file.preview",
          attribute: "filename",
          sourceFile: "infra/main.tf",
        },
      ],
    })
    expect(result.artifact?.manifest.artifactHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.artifact?.files).toEqual([
      expect.objectContaining({
        path: "yaffle_isolation_override.tf.json",
        content: expect.stringContaining("var.filename"),
      }),
    ])
    expect(result.artifact?.files[0]?.content).toContain("(var.filename) == null ? null")
    expect(files[0]?.content).toBe(SOURCE)
  })

  test("regenerates identically and separates every collision-scope identity", () => {
    const first = compile().artifact?.manifest
    const repeated = compile().artifact?.manifest

    expect(repeated).toEqual(first)
    for (const identity of [
      { organizationId: "org-456" },
      { repositoryId: "123456789" },
      { workspacePath: "infra/other" },
      { environmentName: "pr-43" },
    ]) {
      const distinct = compile(identity).artifact?.manifest
      expect(distinct?.suffix).not.toBe(first?.suffix)
      expect(distinct?.artifactHash).not.toBe(first?.artifactHash)
    }
  })

  test("normalizes and truncates literal values within the strategy constraints", () => {
    const literal = "VERY-LONG-FILENAME-".repeat(8)
    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files: [
        {
          path: "infra/main.tf",
          content: SOURCE.replace("var.filename", JSON.stringify(literal)),
        },
        { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
      ],
    })

    const generated = JSON.parse(result.artifact?.files[0]?.content ?? "{}")
    const filename = generated.resource.local_file.preview.filename as string
    expect(filename).toMatch(/^[a-z0-9-]+$/)
    expect(filename).toHaveLength(63)
    expect(result.artifact?.manifest.transformations[0]?.sourceExpression).toBe(literal)
  })

  test("requires review when the exact strategy cannot safely transform the resource", () => {
    const cases = [
      {
        name: "null filename",
        source: SOURCE.replace("filename = var.filename", "filename = null"),
        lock: LOCK_FILE,
      },
      {
        name: "omitted filename",
        source: SOURCE.replace("  filename = var.filename\n", ""),
        lock: LOCK_FILE,
      },
      {
        name: "invalid literal",
        source: SOURCE.replace("var.filename", JSON.stringify("!!!")),
        lock: LOCK_FILE,
      },
      {
        name: "mixed interpolation",
        source: SOURCE.replace("var.filename", '"prefix-${var.filename}"'),
        lock: LOCK_FILE,
      },
      {
        name: "unverified provider version",
        source: SOURCE,
        lock: LOCK_FILE.replaceAll("2.5.3", "2.5.2"),
      },
      {
        name: "unverified provider source",
        source: SOURCE.replace('source  = "hashicorp/local"', 'source  = "acme/local"'),
        lock: LOCK_FILE,
      },
    ]

    for (const testCase of cases) {
      const result = compileAutomaticIsolationArtifact({
        identity: {
          organizationId: "org-123",
          repositoryId: "987654321",
          workspacePath: "infra",
          environmentKind: "transient",
          environmentName: "pr-42",
        },
        sourceRevision: "0123456789abcdef",
        files: [
          { path: "infra/main.tf", content: testCase.source },
          { path: "infra/.terraform.lock.hcl", content: testCase.lock },
        ],
      })

      expect(result.preflight.status, testCase.name).toBe("review_required")
      expect(result.artifact, testCase.name).toBeUndefined()
    }
  })

  test("resolves a renamed provider by canonical source", () => {
    const source = SOURCE.replace("local = {", "files = {")
      .replace('source  = "hashicorp/local"', 'source  = "registry.opentofu.org/hashicorp/local"')
      .replace('content  = "preview"', 'provider = files\n  content  = "preview"')
    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files: [
        { path: "infra/main.tf", content: source },
        { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
      ],
    })

    expect(result.preflight.status).toBe("ready")
    expect(result.artifact?.manifest.transformations).toContainEqual(
      expect.objectContaining({ resourceAddress: "local_file.preview" }),
    )
  })

  test("does not use nested provider declarations or lock files as root evidence", () => {
    const rootSource = `
resource "local_file" "preview" {
  filename = "preview"
  content  = "preview"
}
`
    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files: [
        { path: "infra/main.tf", content: rootSource },
        { path: "infra/ignored/providers.tf", content: SOURCE },
        { path: "infra/ignored/.terraform.lock.hcl", content: LOCK_FILE },
      ],
    })

    expect(result.preflight.status).toBe("review_required")
    expect(result.artifact).toBeUndefined()
  })

  test("uses OpenTofu source precedence when matching .tofu and .tf files coexist", () => {
    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files: [
        {
          path: "infra/main.tf",
          content: 'resource "aws_s3_bucket" "ignored" { bucket = "shared" }',
        },
        { path: "infra/main.tofu", content: SOURCE },
        { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
      ],
    })

    expect(result.preflight.status).toBe("ready")
    expect(result.artifact?.manifest.transformations).toContainEqual(
      expect.objectContaining({
        resourceAddress: "local_file.preview",
        sourceFile: "infra/main.tofu",
      }),
    )
  })

  test("does not apply native-source precedence across JSON syntax", () => {
    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files: [
        { path: "infra/main.tofu", content: SOURCE },
        { path: "infra/main.tf.json", content: "{}" },
        { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
      ],
    })

    expect(result.preflight.status).toBe("blocked")
    expect(result.artifact).toBeUndefined()
  })

  test("parenthesizes a conditional source expression before adding the suffix", () => {
    const source = SOURCE.replace(
      "filename = var.filename",
      'filename = var.enabled ? "preview" : null',
    )
    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files: [
        { path: "infra/main.tf", content: source },
        { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
      ],
    })

    expect(result.preflight.status).toBe("ready")
    expect(result.artifact?.files[0]?.content).toContain(
      '(var.enabled ? \\"preview\\" : null) == null',
    )
  })

  test("fails closed on OpenTofu JSON and repository override files", () => {
    for (const file of [
      { path: "infra/escape.tofu.json", content: "{}" },
      {
        path: "infra/zz_override.tofu",
        content: 'resource "local_file" "preview" { filename = "shared" }',
      },
    ]) {
      const result = compileAutomaticIsolationArtifact({
        identity: {
          organizationId: "org-123",
          repositoryId: "987654321",
          workspacePath: "infra",
          environmentKind: "transient",
          environmentName: "pr-42",
        },
        sourceRevision: "0123456789abcdef",
        files: [
          { path: "infra/main.tf", content: SOURCE },
          { path: "infra/.terraform.lock.hcl", content: LOCK_FILE },
          file,
        ],
      })

      expect(result.preflight.status, file.path).toBe("blocked")
      expect(result.artifact, file.path).toBeUndefined()
    }
  })

  test("verifies the manifest and generated file before execution", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "yaffle-isolation-artifact-"))
    try {
      const artifact = compile().artifact!
      await mkdir(join(workDir, ".yaffle"), { recursive: true })
      await writeFile(
        join(workDir, automaticIsolationArtifactPaths.manifest),
        JSON.stringify(artifact.manifest),
      )
      await writeFile(
        join(workDir, automaticIsolationArtifactPaths.generated),
        artifact.files[0]!.content,
      )

      await expect(
        verifyAutomaticIsolationArtifact(workDir, true, artifact.manifest),
      ).resolves.toMatchObject({ artifactHash: artifact.manifest.artifactHash })

      const otherEnvironment = compile({ environmentName: "pr-43" }).artifact!.manifest
      await expect(
        verifyAutomaticIsolationArtifact(workDir, true, otherEnvironment),
      ).rejects.toThrow(/does not match execution context/)

      await writeFile(join(workDir, automaticIsolationArtifactPaths.generated), "tampered")
      await expect(
        verifyAutomaticIsolationArtifact(workDir, true, artifact.manifest),
      ).rejects.toThrow(/file hash does not match/)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("emits a verification manifest for a data-only opted-in workspace", () => {
    const result = compileAutomaticIsolationArtifact({
      identity: {
        organizationId: "org-123",
        repositoryId: "987654321",
        workspacePath: "infra",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
      sourceRevision: "0123456789abcdef",
      files: [
        {
          path: "infra/main.tf",
          content: `data "terraform_remote_state" "shared" { backend = "local" }`,
        },
      ],
    })

    expect(result.preflight.status).toBe("ready")
    expect(result.artifact).toMatchObject({
      manifest: {
        strategyRevision: "no-managed-resources-v1",
        transformations: [],
        providerLocks: [],
      },
      files: [],
    })
  })

  test("requires a manifest only for automatically isolated execution", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "yaffle-isolation-artifact-"))
    try {
      await expect(verifyAutomaticIsolationArtifact(workDir, false)).resolves.toBeUndefined()
      await expect(verifyAutomaticIsolationArtifact(workDir, true)).rejects.toThrow(
        /not bound to execution context/,
      )
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("removes a verified preview transform before merge-impact execution", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "yaffle-isolation-artifact-"))
    try {
      const artifact = compile().artifact!
      await mkdir(join(workDir, ".yaffle"), { recursive: true })
      await writeFile(
        join(workDir, automaticIsolationArtifactPaths.manifest),
        JSON.stringify(artifact.manifest),
      )
      await writeFile(
        join(workDir, automaticIsolationArtifactPaths.generated),
        artifact.files[0]!.content,
      )

      await removeAutomaticIsolationArtifact(workDir, artifact.manifest)

      await expect(
        readFile(join(workDir, automaticIsolationArtifactPaths.generated)),
      ).rejects.toThrow()
      await expect(
        readFile(join(workDir, automaticIsolationArtifactPaths.manifest)),
      ).rejects.toThrow()
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
