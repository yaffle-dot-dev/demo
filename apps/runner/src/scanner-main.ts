/**
 * Scanner core logic — shared between CLI entry point and Lambda handler.
 *
 * 1. Claims a scan job via API
 * 2. Downloads the repository source archive from GitHub
 * 3. Scans .tf files for module dependencies (in-memory, no disk extraction)
 * 4. Builds the dependency graph
 * 5. Uploads the original tarball to S3 (no re-tarring)
 * 6. Reports result to control plane via API
 *
 * Uses only Node.js APIs (no Bun, no git) so it can run in Lambda's Node.js runtime.
 *
 * NOTE: Git submodules are not supported — the GitHub tarball endpoint does not
 * include submodule contents. If submodule support is needed in the future,
 * this would need to be replaced with a git clone.
 */

import { createHash, randomUUID } from "node:crypto"
import { createGunzip, createGzip } from "node:zlib"
import { Readable } from "node:stream"
import * as tar from "tar-stream"

import {
  buildGraphFromInferred,
  combineAutomaticIsolationPreflights,
  deriveAutomaticIsolationWorkspaceStatus,
  extractDependenciesFromContent,
  extractYaffleModuleOutputReferencesFromContent,
  inspectAutomaticPreviewIsolationWorkspace,
  type AutomaticIsolationFinding,
  type AutomaticIsolationIdentity,
  type AutomaticIsolationPreflight,
  type AutomaticIsolationSourceFile,
  type DependencyScannerVariableBindingsByPath,
  type WorkspaceModuleOutputReference,
} from "@yaffle/shared"

import { ScannerApiClient } from "./lib/scanner-api-client.ts"
import {
  automaticIsolationArtifactPaths,
  AutomaticIsolationArtifactError,
  compileAutomaticIsolationArtifact,
  type CompiledAutomaticIsolationArtifact,
} from "./lib/automatic-isolation-artifact.ts"
import { HeartbeatSupervisor } from "./lib/supervisor.ts"

type TarEntryHeader = {
  linkname?: string
  name: string
  type?: string
}

type TarEntryNext = (error?: Error | null) => void

interface AutomaticIsolationScanContext extends Omit<AutomaticIsolationIdentity, "workspacePath"> {
  sourceRevision: string
}

export function findWorkspaceForTerraformPath(
  relativePath: string,
  workspacePaths: string[],
): string | undefined {
  return [...workspacePaths]
    .sort((left, right) => right.length - left.length)
    .find(
      (workspacePath) =>
        workspacePath === "." ||
        relativePath === workspacePath ||
        relativePath.startsWith(`${workspacePath}/`),
    )
}

function log(message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` ${JSON.stringify(data)}` : ""
  console.log(`[${timestamp}] [scanner] ${message}${dataStr}`)
}

function error(message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` ${JSON.stringify(data)}` : ""
  console.error(`[${timestamp}] [scanner] ERROR: ${message}${dataStr}`)
}

function parseRepoInfo(repoUrl: string): { owner: string; repo: string } {
  const url = new URL(repoUrl)
  const [, owner, repoWithGit] = url.pathname.split("/")
  const repo = repoWithGit?.replace(/\.git$/, "")

  if (!owner || !repo) {
    throw new Error(`Invalid repository URL: ${repoUrl}`)
  }

  return { owner, repo }
}

/**
 * Download repository tarball from GitHub.
 * Returns the raw tarball buffer (for S3 upload) without extracting to disk.
 */
async function downloadTarball(
  repoUrl: string,
  headSha: string,
  installationToken?: string,
): Promise<Buffer> {
  const { owner, repo } = parseRepoInfo(repoUrl)

  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${headSha}`

  log("Downloading repository archive", { owner, repo, headSha: headSha.slice(0, 7) })

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "yaffle-scanner",
  }
  if (installationToken) {
    headers.Authorization = `Bearer ${installationToken}`
  }

  const response = await fetch(tarballUrl, { headers })

  if (!response.ok) {
    throw new Error(`GitHub tarball download failed: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  log("Repository downloaded", { sizeBytes: buffer.length })

  return buffer
}

/**
 * Scan .tf files directly from a tarball without extracting to disk.
 *
 * GitHub tarballs have a single top-level directory ({owner}-{repo}-{sha}/).
 * We strip that prefix to get workspace-relative paths.
 */
export async function scanTarball(
  tarballBuffer: Buffer,
  workspacePaths: string[],
  workspaceVariables: DependencyScannerVariableBindingsByPath,
  currentNamespace: string,
  automaticIsolationWorkspacePaths: string[],
  automaticIsolationContext?: AutomaticIsolationScanContext,
): Promise<{
  workspaces: string[]
  edges: [string, string][]
  moduleOutputReferences: WorkspaceModuleOutputReference[]
  automaticIsolationPreflight?: AutomaticIsolationPreflight
  automaticIsolationArtifacts?: CompiledAutomaticIsolationArtifact[]
}> {
  const knownWorkspaces = new Set(workspacePaths)
  const isolationWorkspaces = new Set(automaticIsolationWorkspacePaths)
  const edges: [string, string][] = []
  const moduleOutputReferences: WorkspaceModuleOutputReference[] = []

  // Map workspace path → concatenated Terraform file contents
  const workspaceContents = new Map<string, AutomaticIsolationSourceFile[]>()
  for (const ws of workspacePaths) {
    workspaceContents.set(ws, [])
  }
  const archiveFindings = new Map<string, AutomaticIsolationFinding[]>()
  for (const ws of automaticIsolationWorkspacePaths) {
    archiveFindings.set(ws, [])
  }

  // Stream through tarball entries, reading only .tf files
  const extract = tar.extract()
  let stripPrefix = ""

  const processing = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header: TarEntryHeader, stream: Readable, next: TarEntryNext) => {
      // Determine the prefix to strip (first directory component)
      if (!stripPrefix && header.type === "directory") {
        stripPrefix = header.name
      }

      const relativePath = stripPrefix ? header.name.replace(stripPrefix, "") : header.name

      if (header.type === "symlink" || header.type === "link") {
        const linkedPath = relativePath.replace(/\/$/, "")
        for (const workspacePath of isolationWorkspaces) {
          const linkAffectsWorkspace =
            workspacePath === "." ||
            linkedPath === workspacePath ||
            linkedPath.startsWith(`${workspacePath}/`) ||
            workspacePath.startsWith(`${linkedPath}/`)
          if (!linkAffectsWorkspace) {
            continue
          }

          archiveFindings.get(workspacePath)!.push({
            code: "symlink_not_supported",
            filePath: linkedPath,
            message:
              `${linkedPath} is a symbolic or hard link${header.linkname ? ` to ${header.linkname}` : ""}. ` +
              "Yaffle cannot prove linked Terraform source belongs to this transient workspace.",
          })
        }
      }

      const isTerraformSource =
        relativePath.endsWith(".tf") ||
        relativePath.endsWith(".tf.json") ||
        relativePath.endsWith(".tofu") ||
        relativePath.endsWith(".tofu.json") ||
        relativePath === ".terraform.lock.hcl" ||
        relativePath.endsWith("/.terraform.lock.hcl")

      // Process Terraform source and lock files within known workspaces.
      if (header.type === "file" && isTerraformSource) {
        // Find which workspace this file belongs to
        const matchingWorkspace = findWorkspaceForTerraformPath(relativePath, workspacePaths)

        if (matchingWorkspace) {
          const chunks: Buffer[] = []
          stream.on("data", (chunk: Buffer) => chunks.push(chunk))
          stream.on("end", () => {
            const content = Buffer.concat(chunks).toString("utf-8")
            workspaceContents.get(matchingWorkspace)!.push({ path: relativePath, content })
            next()
          })
          stream.resume()
          return
        }
      }

      // Skip non-matching entries
      stream.on("end", next)
      stream.resume()
    })

    extract.on("finish", resolve)
    extract.on("error", reject)
  })

  // Pipe: buffer → gunzip → tar extract
  const readable = Readable.from(tarballBuffer)
  const gunzip = createGunzip()

  readable.pipe(gunzip).pipe(extract)
  await processing

  // Convert to edges
  for (const [workspace, files] of workspaceContents) {
    const contents = files
      .filter((file) => file.path.endsWith(".tf") || file.path.endsWith(".tofu"))
      .map((file) => file.content)
    const deps = extractDependenciesFromContent(contents.join("\n\n"), {
      currentNamespace,
      variables: workspaceVariables[workspace],
    })
    for (const dep of deps) {
      if (knownWorkspaces.has(dep) && dep !== workspace) {
        edges.push([workspace, dep])
      }
    }
    const references = extractYaffleModuleOutputReferencesFromContent(contents.join("\n\n"), {
      currentNamespace,
      variables: workspaceVariables[workspace],
    })
    for (const reference of references) {
      if (
        knownWorkspaces.has(reference.producerWorkspacePath) &&
        reference.producerWorkspacePath !== workspace
      ) {
        moduleOutputReferences.push({ consumerWorkspacePath: workspace, ...reference })
      }
    }
  }

  const automaticIsolationArtifacts: CompiledAutomaticIsolationArtifact[] = []
  const automaticIsolationPreflight =
    isolationWorkspaces.size > 0
      ? combineAutomaticIsolationPreflights(
          [...isolationWorkspaces].map((workspacePath) => {
            const files = workspaceContents.get(workspacePath) ?? []
            const compilation = automaticIsolationContext
              ? compileAutomaticIsolationArtifact({
                  identity: {
                    organizationId: automaticIsolationContext.organizationId,
                    repositoryId: automaticIsolationContext.repositoryId,
                    workspacePath,
                    environmentKind: automaticIsolationContext.environmentKind,
                    environmentName: automaticIsolationContext.environmentName,
                  },
                  sourceRevision: automaticIsolationContext.sourceRevision,
                  files,
                })
              : undefined
            const inspected =
              compilation?.preflight ??
              inspectAutomaticPreviewIsolationWorkspace(workspacePath, files)
            const findings = [...inspected.findings, ...(archiveFindings.get(workspacePath) ?? [])]
            const preflight = {
              ...inspected,
              status: deriveAutomaticIsolationWorkspaceStatus(findings),
              findings,
            }
            if (preflight.status === "ready" && compilation?.artifact) {
              automaticIsolationArtifacts.push(compilation.artifact)
            }
            return preflight
          }),
        )
      : undefined

  log("Tarball scan complete", {
    workspaceCount: workspacePaths.length,
    edgeCount: edges.length,
    moduleOutputReferenceCount: moduleOutputReferences.length,
  })

  return {
    workspaces: workspacePaths,
    edges,
    moduleOutputReferences,
    automaticIsolationPreflight,
    automaticIsolationArtifacts:
      automaticIsolationArtifacts.length > 0 ? automaticIsolationArtifacts : undefined,
  }
}

/**
 * Repackage a GitHub tarball with the prefix directory stripped.
 *
 * GitHub tarballs extract to {owner}-{repo}-{sha}/ — runners expect
 * clean paths (e.g., infra/production/ not yaffle-dot-dev-yaffle-abc123/infra/production/).
 */
export async function repackageTarball(
  tarballBuffer: Buffer,
  automaticIsolationArtifacts: CompiledAutomaticIsolationArtifact[] = [],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract()
    const pack = tar.pack()
    const chunks: Buffer[] = []
    const sourcePaths = new Set<string>()
    let stripPrefix = ""

    extract.on("entry", (header: TarEntryHeader, stream: Readable, next: TarEntryNext) => {
      // Detect the prefix from the first directory entry
      if (!stripPrefix && header.type === "directory") {
        stripPrefix = header.name
      }

      // Strip the prefix from all entry names
      const newName = stripPrefix ? header.name.replace(stripPrefix, "") : header.name

      // Skip the root directory entry itself (empty name after stripping)
      if (!newName || newName === "/") {
        stream.on("end", next)
        stream.resume()
        return
      }

      sourcePaths.add(newName)

      // Write entry with stripped name
      const entry = pack.entry({ ...header, name: newName }, next)
      stream.pipe(entry)
    })

    extract.on("finish", () => {
      const generatedEntries = automaticIsolationArtifacts.flatMap((artifact) => {
        const workspacePrefix =
          artifact.manifest.identity.workspacePath === "."
            ? ""
            : `${artifact.manifest.identity.workspacePath}/`
        return [
          ...artifact.files.map((file) => ({
            name: `${workspacePrefix}${file.path}`,
            content: file.content,
          })),
          {
            name: `${workspacePrefix}${automaticIsolationArtifactPaths.manifest}`,
            content: `${JSON.stringify(artifact.manifest, null, 2)}\n`,
          },
        ]
      })

      const appendNext = (index: number): void => {
        const generated = generatedEntries[index]
        if (!generated) {
          pack.finalize()
          return
        }
        if (sourcePaths.has(generated.name)) {
          reject(
            new AutomaticIsolationArtifactError(
              `Repository source uses reserved automatic isolation path: ${generated.name}`,
              "RESERVED_PATH_CONFLICT",
            ),
          )
          return
        }
        sourcePaths.add(generated.name)
        const entry = pack.entry(
          {
            name: generated.name,
            type: "file",
            size: Buffer.byteLength(generated.content),
          },
          (entryError) => {
            if (entryError) {
              reject(entryError)
              return
            }
            appendNext(index + 1)
          },
        )
        entry.end(generated.content)
      }

      appendNext(0)
    })

    extract.on("error", reject)

    // Collect the packed output through gzip
    const gzip = createGzip()
    pack.pipe(gzip)

    gzip.on("data", (chunk: Buffer) => chunks.push(chunk))
    gzip.on("end", () => resolve(Buffer.concat(chunks)))
    gzip.on("error", reject)

    // Feed the input: buffer → gunzip → extract
    const readable = Readable.from(tarballBuffer)
    const gunzip = createGunzip()
    readable.pipe(gunzip).pipe(extract)
  })
}

/**
 * Run the scanner. Reads config from environment variables.
 * Used by both the CLI entry point and the Lambda handler.
 */
export async function runScanner(): Promise<void> {
  const scanJobId = process.env.YAFFLE_SCAN_JOB_ID
  const jobToken = process.env.YAFFLE_JOB_TOKEN
  const apiUrl = process.env.YAFFLE_API_URL

  if (!scanJobId || !jobToken || !apiUrl) {
    throw new Error("YAFFLE_SCAN_JOB_ID, YAFFLE_JOB_TOKEN, and YAFFLE_API_URL are required")
  }

  const workerId = `scanner-${process.pid}-${randomUUID().slice(0, 8)}`

  log("Scanner starting", { scanJobId, workerId, apiUrl })

  const apiClient = new ScannerApiClient({
    apiUrl,
    jobToken,
    scanJobId,
  })

  // 1. Claim scan job
  log("Claiming scan job...")
  const claimResult = await apiClient.claim(workerId)

  log("Scan job claimed", {
    runGroupId: claimResult.runGroupId,
    headSha: claimResult.headSha.slice(0, 7),
  })

  // 2. Start heartbeat supervisor
  const supervisor = new HeartbeatSupervisor({
    apiClient,
    onHeartbeatFailure: () => {
      error("Heartbeat rejected — scan job may have been reclaimed or timed out")
    },
  })
  supervisor.start()

  try {
    // 3. Download the repository tarball
    const tarballBuffer = await downloadTarball(
      claimResult.repoUrl,
      claimResult.headSha,
      claimResult.installationToken,
    )

    const { repo } = parseRepoInfo(claimResult.repoUrl)
    const currentNamespace = `${claimResult.orgSlug}--${repo}`

    // 4. Scan dependencies directly from tarball (no disk extraction)
    const workspacePaths = claimResult.workspacePaths
    log("Scanning dependencies...", { workspaceCount: workspacePaths.length })

    const inferredGraph = await scanTarball(
      tarballBuffer,
      workspacePaths,
      claimResult.workspaceVariables,
      currentNamespace,
      claimResult.automaticIsolationWorkspacePaths,
      claimResult.automaticIsolationContext,
    )
    const graph = buildGraphFromInferred(inferredGraph.workspaces, inferredGraph.edges)

    const cycleCheck = graph.detectCycle()
    if (cycleCheck.hasCycle) {
      const cyclePath = cycleCheck.cyclePath?.join(" -> ") ?? "unknown"
      throw new Error(`Circular dependency detected: ${cyclePath}`)
    }

    const executionOrder = graph.getTopologicalOrder()
    if (!executionOrder) {
      throw new Error("Failed to compute execution order")
    }

    // Filter + fill execution order to match workspace paths
    const configPaths = new Set(workspacePaths)
    const filteredOrder = executionOrder.filter((path) => configPaths.has(path))
    for (const path of workspacePaths) {
      if (!filteredOrder.includes(path)) {
        filteredOrder.push(path)
      }
    }

    log("Dependency scan complete", {
      executionOrder: filteredOrder,
      edgeCount: inferredGraph.edges.length,
    })

    if (
      inferredGraph.automaticIsolationPreflight &&
      inferredGraph.automaticIsolationPreflight.status !== "ready"
    ) {
      await apiClient.complete({
        graph: graph.toSerializable(),
        executionOrder: filteredOrder,
        moduleOutputReferences: inferredGraph.moduleOutputReferences,
        automaticIsolationPreflight: inferredGraph.automaticIsolationPreflight,
      })
      log("Automatic preview isolation preflight requires attention", {
        status: inferredGraph.automaticIsolationPreflight.status,
      })
      return
    }

    // 5. Repackage tarball (strip GitHub's prefix dir) and upload to S3
    let workspaceS3Key: string | undefined
    let workspaceArtifactSha256: string | undefined
    if (claimResult.workspaceUploadUrl) {
      try {
        log("Repackaging tarball (stripping prefix)...")
        const cleanTarball = await repackageTarball(
          tarballBuffer,
          inferredGraph.automaticIsolationArtifacts,
        )
        workspaceArtifactSha256 = createHash("sha256").update(cleanTarball).digest("hex")
        log("Uploading workspace to S3", { sizeBytes: cleanTarball.length })

        const uploadResponse = await fetch(claimResult.workspaceUploadUrl, {
          method: "PUT",
          body: Uint8Array.from(cleanTarball),
          headers: { "Content-Type": "application/gzip" },
        })

        if (!uploadResponse.ok) {
          throw new Error(`S3 upload failed: ${uploadResponse.status}`)
        }

        if (!claimResult.workspaceS3Key) {
          throw new Error("Scanner claim did not include a workspace artifact key")
        }
        workspaceS3Key = claimResult.workspaceS3Key
        log("Workspace uploaded successfully")
      } catch (err) {
        error("Workspace upload failed (non-fatal)", { error: String(err) })
      }
    }

    // 6. Report success
    await apiClient.complete({
      graph: graph.toSerializable(),
      executionOrder: filteredOrder,
      moduleOutputReferences: inferredGraph.moduleOutputReferences,
      workspaceS3Key,
      workspaceArtifactSha256,
      automaticIsolationPreflight: inferredGraph.automaticIsolationPreflight,
      automaticIsolationArtifacts: inferredGraph.automaticIsolationArtifacts?.map(
        (artifact) => artifact.manifest,
      ),
    })

    log("Scan result reported successfully")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    error("Scan failed", { error: msg })

    try {
      await apiClient.fail(msg)
    } catch (reportErr) {
      error("Failed to report scan failure", { error: String(reportErr) })
    }

    throw err
  } finally {
    supervisor.stop()
  }

  log("Scanner done")
}
