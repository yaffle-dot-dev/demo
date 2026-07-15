import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { createGzip } from "node:zlib"

import * as tar from "tar-stream"

import { describe, expect, test } from "@yaffle/test"
import type { AutomaticIsolationArtifactManifest } from "@yaffle/shared"

import type { ExecutionContext } from "./api-client.ts"
import type { CompiledAutomaticIsolationArtifact } from "./automatic-isolation-artifact.ts"
import { executeTerraform } from "./executor.ts"
import { downloadWorkspace } from "./workspace.ts"
import { repackageTarball, scanTarball } from "../scanner-main.ts"

const execFileAsync = promisify(execFile)
const FIXTURE_DIR = join(process.cwd(), "testdata/runner/automatic-isolation-local-file")

function executionContext(
  command: "plan" | "apply" | "destroy",
  automaticIsolationRequired: boolean,
  workspaceArtifactSha256: string,
  automaticIsolationManifest?: AutomaticIsolationArtifactManifest,
): ExecutionContext {
  return {
    workspaceUrl: "fixture://automatic-isolation-local-file",
    workspaceArtifactSha256,
    command,
    workspacePath: "infra",
    automaticIsolationRequired,
    automaticIsolationManifest,
    variables: {},
  }
}

async function sourceTarball(source: string, lockFile: string): Promise<Buffer> {
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
  for (const [path, content] of [
    ["infra/main.tf", source],
    ["infra/.terraform.lock.hcl", lockFile],
  ] as const) {
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

async function prepareWorkspace(automaticIsolation: boolean): Promise<{
  workDir: string
  source: string
  digest: string
  manifest?: AutomaticIsolationArtifactManifest
}> {
  const source = await readFile(join(FIXTURE_DIR, "main.tf"), "utf8")
  const lockFile = await readFile(join(FIXTURE_DIR, ".terraform.lock.hcl"), "utf8")
  const sourceArchive = await sourceTarball(source, lockFile)
  let artifacts: CompiledAutomaticIsolationArtifact[] | undefined
  if (automaticIsolation) {
    const scan = await scanTarball(sourceArchive, ["infra"], {}, "org--repo", ["infra"], {
      organizationId: "01JYAFFLEORG",
      repositoryId: "987654321",
      environmentKind: "transient",
      environmentName: "pr-42",
      sourceRevision: "0123456789abcdef",
    })
    expect(scan.automaticIsolationPreflight?.status).toBe("ready")
    artifacts = scan.automaticIsolationArtifacts
  }
  const executionArchive = await repackageTarball(sourceArchive, artifacts)
  const digest = createHash("sha256").update(executionArchive).digest("hex")
  const workDir = await downloadWorkspace(
    `data:application/gzip;base64,${executionArchive.toString("base64")}`,
    "infra",
    digest,
  )
  return { workDir, source, digest, manifest: artifacts?.[0]?.manifest }
}

describe("automatic isolation OpenTofu artifact", () => {
  test("validates, plans deterministically, applies, and destroys without changing source", async () => {
    const isolated = await prepareWorkspace(true)
    const named = await prepareWorkspace(false)
    try {
      const manifest = isolated.manifest!

      await execFileAsync("tofu", ["init", "-backend=false", "-input=false", "-no-color"], {
        cwd: isolated.workDir,
      })
      await execFileAsync("tofu", ["validate", "-no-color"], { cwd: isolated.workDir })

      const firstPlan = await executeTerraform({
        workDir: isolated.workDir,
        context: executionContext("plan", true, isolated.digest, manifest),
      })
      const repeatedPlan = await executeTerraform({
        workDir: isolated.workDir,
        context: executionContext("plan", true, isolated.digest, manifest),
      })
      expect(firstPlan.success).toBe(true)
      expect(firstPlan.hasChanges).toBe(true)
      expect(repeatedPlan.success).toBe(true)
      expect(repeatedPlan.hasChanges).toBe(true)
      expect(
        (repeatedPlan.planJson as { resource_changes?: unknown } | undefined)?.resource_changes,
      ).toEqual(
        (firstPlan.planJson as { resource_changes?: unknown } | undefined)?.resource_changes,
      )

      const apply = await executeTerraform({
        workDir: isolated.workDir,
        context: executionContext("apply", true, isolated.digest, manifest),
      })
      expect(apply.success).toBe(true)
      const isolatedFilename = (apply.outputs?.filename as { value?: string })?.value
      expect(isolatedFilename).toBe(`preview-file-${manifest.suffix}`)
      await expect(access(join(isolated.workDir, isolatedFilename!))).resolves.toBeUndefined()

      const noChangePlan = await executeTerraform({
        workDir: isolated.workDir,
        context: executionContext("plan", true, isolated.digest, manifest),
      })
      expect(noChangePlan.success).toBe(true)
      expect(noChangePlan.hasChanges).toBe(false)

      const destroy = await executeTerraform({
        workDir: isolated.workDir,
        context: executionContext("destroy", true, isolated.digest, manifest),
      })
      expect(destroy.success).toBe(true)
      await expect(access(join(isolated.workDir, isolatedFilename!))).rejects.toThrow()
      expect(await readFile(join(FIXTURE_DIR, "main.tf"), "utf8")).toBe(isolated.source)

      const namedApply = await executeTerraform({
        workDir: named.workDir,
        context: executionContext("apply", false, named.digest),
      })
      expect(namedApply.success).toBe(true)
      expect((namedApply.outputs?.filename as { value?: string })?.value).toBe("preview-file")
      await expect(access(join(named.workDir, "preview-file"))).resolves.toBeUndefined()

      const namedDestroy = await executeTerraform({
        workDir: named.workDir,
        context: executionContext("destroy", false, named.digest),
      })
      expect(namedDestroy.success).toBe(true)
    } finally {
      await Promise.all([
        rm(dirname(dirname(isolated.workDir)), { recursive: true, force: true }),
        rm(dirname(dirname(named.workDir)), { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})
