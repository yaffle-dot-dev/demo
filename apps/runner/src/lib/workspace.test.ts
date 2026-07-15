import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { createGzip } from "node:zlib"

import * as tar from "tar-stream"

import { describe, expect, test } from "@yaffle/test"

import { downloadWorkspace } from "./workspace.ts"

async function workspaceTarball(): Promise<Buffer> {
  const pack = tar.pack()
  const gzip = createGzip()
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk))
    gzip.on("end", () => resolve(Buffer.concat(chunks)))
    gzip.on("error", reject)
  })
  pack.pipe(gzip)
  const content = 'resource "terraform_data" "example" {}\n'
  const entry = pack.entry({
    name: "infra/main.tf",
    type: "file",
    size: Buffer.byteLength(content),
  })
  entry.end(content)
  pack.finalize()
  return completed
}

describe("downloadWorkspace", () => {
  test("extracts an artifact only when its trusted digest matches", async () => {
    const tarball = await workspaceTarball()
    const digest = createHash("sha256").update(tarball).digest("hex")
    const url = `data:application/gzip;base64,${tarball.toString("base64")}`

    const workDir = await downloadWorkspace(url, "infra", digest)
    try {
      expect(await readFile(`${workDir}/main.tf`, "utf8")).toContain("terraform_data")
    } finally {
      await rm(dirname(dirname(workDir)), { recursive: true, force: true })
    }

    await expect(downloadWorkspace(url, "infra", "0".repeat(64))).rejects.toThrow(
      /digest does not match/,
    )
  })
})
