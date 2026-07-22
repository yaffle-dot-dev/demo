import { Readable } from "node:stream"
import { createGunzip, createGzip } from "node:zlib"

import * as tar from "tar-stream"

import { describe, expect, test } from "@yaffle/test"

import { findWorkspaceForTerraformPath, repackageTarball, scanTarball } from "./scanner-main.ts"

async function createSymlinkTarball(name: string, linkname: string): Promise<Buffer> {
  const pack = tar.pack()
  const gzip = createGzip()
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk))
    gzip.on("end", () => resolve(Buffer.concat(chunks)))
    gzip.on("error", reject)
  })

  pack.pipe(gzip)
  pack.entry({ name: "repo-sha/", type: "directory" })
  pack.entry({
    name: `repo-sha/${name}`,
    type: "symlink",
    linkname,
  })
  const sharedResourceContent = 'resource "aws_s3_bucket" "shared" {}'
  const sharedResource = pack.entry({
    name: "repo-sha/shared/main.tf",
    type: "file",
    size: Buffer.byteLength(sharedResourceContent),
  })
  sharedResource.end(sharedResourceContent)
  pack.finalize()

  return completed
}

async function createSourceTarball(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack()
  const gzip = createGzip()
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk))
    gzip.on("end", () => resolve(Buffer.concat(chunks)))
    gzip.on("error", reject)
  })

  pack.pipe(gzip)
  pack.entry({ name: "repo-sha/", type: "directory" })
  for (const [path, content] of Object.entries(files)) {
    const entry = pack.entry({
      name: `repo-sha/${path}`,
      type: "file",
      size: Buffer.byteLength(content),
    })
    entry.end(content)
  }
  pack.finalize()

  return completed
}

async function readTarballFiles(buffer: Buffer): Promise<Record<string, string>> {
  const extract = tar.extract()
  const files: Record<string, string> = {}
  const completed = new Promise<Record<string, string>>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("end", () => {
        if (header.type === "file") {
          files[header.name] = Buffer.concat(chunks).toString("utf8")
        }
        next()
      })
      stream.resume()
    })
    extract.on("finish", () => resolve(files))
    extract.on("error", reject)
  })

  Readable.from(buffer).pipe(createGunzip()).pipe(extract)
  return completed
}

describe("findWorkspaceForTerraformPath", () => {
  test("attributes files to the most specific nested workspace", () => {
    expect(findWorkspaceForTerraformPath("infra/app/main.tf", ["infra", "infra/app"])).toBe(
      "infra/app",
    )
  })

  test("uses the root workspace only when no nested workspace matches", () => {
    expect(findWorkspaceForTerraformPath("main.tf", [".", "infra/app"])).toBe(".")
    expect(findWorkspaceForTerraformPath("infra/app/main.tf", [".", "infra/app"])).toBe("infra/app")
  })
})

describe("scanTarball", () => {
  test("reports same-repository module output references", async () => {
    const result = await scanTarball(
      await createSourceTarball({
        "infra/shared/main.tf": `output "cluster_arn" { value = "test" }`,
        "apps/api/infra/main.tf": `
module "shared" {
  source = "yaffle.dev/org--repo/infra--shared/yaffle"
}

locals {
  cluster_arn = module.shared.cluster_arn
}
`,
      }),
      ["infra/shared", "apps/api/infra"],
      {},
      "org--repo",
      [],
    )

    expect(result.moduleOutputReferences).toEqual([
      {
        consumerWorkspacePath: "apps/api/infra",
        producerWorkspacePath: "infra/shared",
        moduleName: "shared",
        outputName: "cluster_arn",
      },
    ])
  })

  test("reports named-only output references without adding them to the transient graph", async () => {
    const result = await scanTarball(
      await createSourceTarball({
        "apps/api/infra/main.tf": `
module "shared" {
  source = "yaffle.dev/org--repo/infra--shared/yaffle"
}

locals {
  cluster_arn = module.shared.cluster_arn
}
`,
      }),
      ["apps/api/infra"],
      {},
      "org--repo",
      [],
    )

    expect(result.edges).toEqual([])
    expect(result.moduleOutputReferences).toEqual([
      {
        consumerWorkspacePath: "apps/api/infra",
        producerWorkspacePath: "infra/shared",
        moduleName: "shared",
        outputName: "cluster_arn",
      },
    ])
  })

  test("blocks linked Terraform source in an automatically isolated workspace", async () => {
    const result = await scanTarball(
      await createSymlinkTarball("infra/main.tf", "../shared/main.tf"),
      ["infra"],
      {},
      "org--repo",
      ["infra"],
    )

    expect(result.automaticIsolationPreflight).toEqual({
      status: "blocked",
      workspaces: [
        {
          workspacePath: "infra",
          status: "blocked",
          findings: [
            expect.objectContaining({
              code: "symlink_not_supported",
              filePath: "infra/main.tf",
            }),
          ],
        },
      ],
    })
  })

  test("blocks a linked automatically isolated workspace directory", async () => {
    const result = await scanTarball(
      await createSymlinkTarball("infra", "shared"),
      ["infra"],
      {},
      "org--repo",
      ["infra"],
    )

    expect(result.automaticIsolationPreflight).toEqual({
      status: "blocked",
      workspaces: [
        expect.objectContaining({
          workspacePath: "infra",
          status: "blocked",
          findings: [
            expect.objectContaining({
              code: "symlink_not_supported",
              filePath: "infra",
            }),
          ],
        }),
      ],
    })
  })

  test("compiles a verified strategy while scanning an opted-in workspace", async () => {
    const result = await scanTarball(
      await createSourceTarball({
        "infra/main.tf": `
terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.3"
    }
  }
}

resource "local_file" "preview" {
  filename = "preview"
  content  = "preview"
}
`,
        "infra/.terraform.lock.hcl": `
provider "registry.opentofu.org/hashicorp/local" {
  version = "2.5.3"
  hashes  = ["h1:test"]
}
`,
      }),
      ["infra"],
      {},
      "org--repo",
      ["infra"],
      {
        organizationId: "org-123",
        repositoryId: "987654321",
        environmentKind: "transient",
        environmentName: "pr-42",
        sourceRevision: "0123456789abcdef",
      },
    )

    expect(result.automaticIsolationPreflight?.status).toBe("ready")
    expect(result.automaticIsolationArtifacts).toEqual([
      expect.objectContaining({
        manifest: expect.objectContaining({
          sourceRevision: "0123456789abcdef",
          transformations: [expect.objectContaining({ resourceAddress: "local_file.preview" })],
        }),
      }),
    ])
  })

  test("collects native OpenTofu sources and rejects OpenTofu JSON", async () => {
    const source = `
terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.3"
    }
  }
}

resource "local_file" "preview" {
  filename = "preview"
  content  = "preview"
}
`
    const lock = `
provider "registry.opentofu.org/hashicorp/local" {
  version = "2.5.3"
  hashes  = ["h1:test"]
}
`
    const context = {
      organizationId: "org-123",
      repositoryId: "987654321",
      environmentKind: "transient" as const,
      environmentName: "pr-42",
      sourceRevision: "0123456789abcdef",
    }
    const nativeResult = await scanTarball(
      await createSourceTarball({
        "infra/main.tofu": source,
        "infra/.terraform.lock.hcl": lock,
      }),
      ["infra"],
      {},
      "org--repo",
      ["infra"],
      context,
    )
    const jsonResult = await scanTarball(
      await createSourceTarball({
        "infra/main.tofu": source,
        "infra/escape.tofu.json": "{}",
        "infra/.terraform.lock.hcl": lock,
      }),
      ["infra"],
      {},
      "org--repo",
      ["infra"],
      context,
    )

    expect(nativeResult.automaticIsolationPreflight?.status).toBe("ready")
    expect(nativeResult.automaticIsolationArtifacts?.[0]?.manifest.transformations).toContainEqual(
      expect.objectContaining({ sourceFile: "infra/main.tofu" }),
    )
    expect(jsonResult.automaticIsolationPreflight?.status).toBe("blocked")
    expect(jsonResult.automaticIsolationArtifacts).toBeUndefined()
  })

  test("packages generated artifacts without changing repository source files", async () => {
    const source = `terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.3"
    }
  }
}

resource "local_file" "preview" {
  filename = "preview"
  content  = "preview"
}
`
    const tarball = await createSourceTarball({
      "infra/main.tf": source,
      "infra/.terraform.lock.hcl": `
provider "registry.opentofu.org/hashicorp/local" {
  version = "2.5.3"
  hashes  = ["h1:test"]
}
`,
    })
    const scan = await scanTarball(tarball, ["infra"], {}, "org--repo", ["infra"], {
      organizationId: "org-123",
      repositoryId: "987654321",
      environmentKind: "transient",
      environmentName: "pr-42",
      sourceRevision: "0123456789abcdef",
    })

    const packaged = await readTarballFiles(
      await repackageTarball(tarball, scan.automaticIsolationArtifacts),
    )

    expect(packaged["infra/main.tf"]).toBe(source)
    expect(packaged["infra/yaffle_isolation_override.tf.json"]).toContain("local_file")
    expect(
      JSON.parse(packaged["infra/.yaffle/automatic-isolation-artifact.json"] ?? "{}"),
    ).toMatchObject({ sourceRevision: "0123456789abcdef" })
  })
})
