#!/usr/bin/env bun
/**
 * Yaffle Scanner Worker
 *
 * A standalone worker process that:
 * 1. Claims a scan job atomically via API
 * 2. Clones the repository
 * 3. Reads yaffle.toml config from the clone
 * 4. Scans .tf files for module dependencies
 * 5. Builds the dependency graph
 * 6. Uploads workspace tarball to S3
 * 7. Reports result to control plane via API
 *
 * The control plane then handles creating deployments and queuing plan jobs.
 *
 * Environment variables:
 * - YAFFLE_SCAN_JOB_ID: The scan job ID to execute (required)
 * - YAFFLE_JOB_TOKEN: JWT token for API authentication (required)
 * - YAFFLE_API_URL: Control plane API URL (required)
 */

import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  scanAllWorkspaceDependencies,
  buildGraphFromInferred,
} from "@yaffle/shared"

import { ScannerApiClient } from "./lib/scanner-api-client.ts"
import { HeartbeatSupervisor } from "./lib/supervisor.ts"

// Required environment variables
const SCAN_JOB_ID = process.env.YAFFLE_SCAN_JOB_ID
const JOB_TOKEN = process.env.YAFFLE_JOB_TOKEN
const API_URL = process.env.YAFFLE_API_URL

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

/**
 * Clone a repository to a temporary directory.
 */
async function cloneRepo(
  repoUrl: string,
  headSha: string,
  installationToken?: string,
): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "yaffle-scan-"))

  // Build clone URL with token auth if available
  let cloneUrl = repoUrl
  if (installationToken && repoUrl.startsWith("https://")) {
    const url = new URL(repoUrl)
    url.username = "x-access-token"
    url.password = installationToken
    cloneUrl = url.toString()
  }

  log("Cloning repository", { headSha: headSha.slice(0, 7) })

  // Shallow clone
  const cloneResult = Bun.spawnSync(
    ["git", "clone", "--depth", "1", cloneUrl, workDir],
    { stderr: "pipe", stdout: "pipe" },
  )

  if (cloneResult.exitCode !== 0) {
    const stderr = cloneResult.stderr.toString()
    await rm(workDir, { recursive: true, force: true })
    throw new Error(`git clone failed: ${stderr}`)
  }

  // Check if we need to fetch the specific SHA
  const headResult = Bun.spawnSync(
    ["git", "rev-parse", "HEAD"],
    { cwd: workDir, stderr: "pipe", stdout: "pipe" },
  )

  const clonedSha = headResult.stdout.toString().trim()

  if (clonedSha !== headSha) {
    log("Fetching specific SHA", { clonedSha: clonedSha.slice(0, 7), targetSha: headSha.slice(0, 7) })

    const fetchResult = Bun.spawnSync(
      ["git", "fetch", "origin", headSha, "--depth", "1"],
      { cwd: workDir, stderr: "pipe", stdout: "pipe" },
    )

    if (fetchResult.exitCode !== 0) {
      await rm(workDir, { recursive: true, force: true })
      throw new Error(`git fetch failed: ${fetchResult.stderr.toString()}`)
    }

    const checkoutResult = Bun.spawnSync(
      ["git", "checkout", headSha],
      { cwd: workDir, stderr: "pipe", stdout: "pipe" },
    )

    if (checkoutResult.exitCode !== 0) {
      await rm(workDir, { recursive: true, force: true })
      throw new Error(`git checkout failed: ${checkoutResult.stderr.toString()}`)
    }
  }

  return workDir
}

/**
 * Create a tarball of the workspace and upload to S3 via presigned URL.
 */
async function uploadWorkspace(
  repoDir: string,
  uploadUrl: string,
): Promise<void> {
  const tarballPath = join(tmpdir(), `yaffle-scan-${Date.now()}.tar.gz`)

  try {
    log("Creating workspace tarball")

    const tarResult = Bun.spawnSync(
      ["tar", "-czf", tarballPath, "-C", repoDir, "."],
      { stderr: "pipe", stdout: "pipe" },
    )

    if (tarResult.exitCode !== 0) {
      throw new Error(`tar failed: ${tarResult.stderr.toString()}`)
    }

    const tarballData = await readFile(tarballPath)
    log("Uploading workspace to S3", { sizeBytes: tarballData.length })

    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: tarballData,
      headers: { "Content-Type": "application/gzip" },
    })

    if (!response.ok) {
      throw new Error(`S3 upload failed: ${response.status} ${await response.text()}`)
    }

    log("Workspace uploaded successfully")
  } finally {
    await rm(tarballPath, { force: true })
  }
}

async function main(): Promise<void> {
  if (!SCAN_JOB_ID) {
    error("YAFFLE_SCAN_JOB_ID not set")
    process.exit(1)
  }

  if (!JOB_TOKEN) {
    error("YAFFLE_JOB_TOKEN not set")
    process.exit(1)
  }

  if (!API_URL) {
    error("YAFFLE_API_URL not set")
    process.exit(1)
  }

  const workerId = `scanner-${process.pid}-${randomUUID().slice(0, 8)}`

  log("Scanner starting", { scanJobId: SCAN_JOB_ID, workerId, apiUrl: API_URL })

  const apiClient = new ScannerApiClient({
    apiUrl: API_URL,
    jobToken: JOB_TOKEN,
    scanJobId: SCAN_JOB_ID,
  })

  // 1. Claim scan job
  log("Claiming scan job...")
  let claimResult
  try {
    claimResult = await apiClient.claim(workerId)
  } catch (err) {
    error("Failed to claim scan job", { error: String(err) })
    process.exit(1)
  }

  log("Scan job claimed", {
    runGroupId: claimResult.runGroupId,
    headSha: claimResult.headSha.slice(0, 7),
  })

  // 2. Start heartbeat supervisor
  // Heartbeat keeps the scan job alive during long clones.
  // Unlike terraform runners, we don't exit on heartbeat rejection —
  // if the job was already completed/failed, the heartbeat will be
  // rejected but we should still finish reporting the result.
  let heartbeatRejected = false
  const supervisor = new HeartbeatSupervisor({
    apiClient,
    onHeartbeatFailure: () => {
      heartbeatRejected = true
      error("Heartbeat rejected — scan job may have been reclaimed or timed out")
    },
  })
  supervisor.start()

  let repoDir: string | undefined

  try {
    // 3. Clone the repository
    repoDir = await cloneRepo(
      claimResult.repoUrl,
      claimResult.headSha,
      claimResult.installationToken,
    )
    log("Repository cloned", { repoDir })

    // 4. Scan dependencies using workspace paths from CP
    const workspacePaths = claimResult.workspacePaths
    log("Scanning dependencies...", { workspaceCount: workspacePaths.length })
    const inferredGraph = await scanAllWorkspaceDependencies(repoDir, workspacePaths)
    const graph = buildGraphFromInferred(inferredGraph.workspaces, inferredGraph.edges)

    const cycleCheck = graph.detectCycle()
    if (cycleCheck.hasCycle) {
      const cyclePath = cycleCheck.cyclePath?.join(" → ") ?? "unknown"
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

    // 6. Upload workspace to S3 (if upload URL provided)
    let workspaceS3Key: string | undefined
    if (claimResult.workspaceUploadUrl) {
      try {
        await uploadWorkspace(repoDir, claimResult.workspaceUploadUrl)
        // Derive the S3 key from the claim context
        const ref = claimResult.ref.replace("refs/heads/", "")
        workspaceS3Key = `${claimResult.orgSlug}/${ref}/${claimResult.headSha}/workspace.tar.gz`
      } catch (err) {
        // Log but don't fail — runners can fall back to git clone
        error("Workspace upload failed (non-fatal)", { error: String(err) })
      }
    }

    // 7. Report success
    await apiClient.complete({
      graph: graph.toSerializable(),
      executionOrder: filteredOrder,
      workspaceS3Key,
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

    process.exit(1)
  } finally {
    supervisor.stop()

    if (repoDir) {
      try {
        await rm(repoDir, { recursive: true, force: true })
      } catch {
        // Best effort cleanup
      }
    }
  }

  log("Scanner done")
  process.exit(0)
}

main().catch((err) => {
  error("Unhandled error", { error: String(err) })
  process.exit(1)
})
