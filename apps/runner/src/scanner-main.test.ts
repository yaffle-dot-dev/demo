import { createGzip } from "node:zlib"

import { describe, expect, test } from "@yaffle/test"
import * as tar from "tar-stream"

import { findWorkspaceForTerraformPath, scanTarball } from "./scanner-main.ts"

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
})
