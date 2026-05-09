/**
 * Local Engine Spawner
 *
 * Spawns runner workers as detached child processes that survive CP restarts.
 *
 * Key design principles:
 * - Workers run as independent processes (survive HMR, deployments, crashes)
 * - Workers communicate via API only (claim, heartbeat, complete)
 * - Jobs stay "queued" until worker claims them atomically
 * - If spawn fails, job stays queued and will be picked up later
 */

import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import type { IacEngineSpawner } from "./scheduler.ts"
import { generateJobToken } from "./job-token.ts"
import { getJobWithContext } from "../db/queries/iac-jobs.ts"
import { logger } from "./telemetry.ts"

/**
 * Configuration for the local spawner.
 */
export interface LocalSpawnerConfig {
  /** API URL for runners to connect to */
  apiUrl?: string
}

/**
 * Local engine spawner that uses detached child processes.
 *
 * Each spawned process:
 * 1. Claims its assigned job via API
 * 2. Sends heartbeats while executing
 * 3. Reports completion via API
 * 4. Exits
 *
 * If the CP restarts, in-flight workers continue running because they're detached.
 */
export class LocalChildProcessSpawner implements IacEngineSpawner {
  private readonly apiUrl: string

  constructor(config: LocalSpawnerConfig = {}) {
    const apiUrl = config.apiUrl
      ?? process.env.YAFFLE_RUNNER_API_URL

    if (!apiUrl) {
      throw new Error("YAFFLE_RUNNER_API_HOST must be configured")
    }

    this.apiUrl = apiUrl
  }

  async spawn(jobId: string, jobToken: string): Promise<void> {
    // Get the runner script path
    // __dirname is apps/control-plane/src/lib, so go up 3 levels to repo root
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
    const runnerScript = resolve(repoRoot, "apps/runner/src/worker.ts")

    logger.info("Spawning local worker process", {
      jobId,
      apiUrl: this.apiUrl,
      runnerScript,
    })

    const child = spawn(process.execPath, ["--import", "tsx", runnerScript], {
      cwd: repoRoot,
      detached: true, // Survives parent death
      stdio: ["ignore", "pipe", "pipe"], // Capture stdout/stderr for debugging
      env: {
        ...process.env,
        YAFFLE_JOB_ID: jobId,
        YAFFLE_JOB_TOKEN: jobToken,
        YAFFLE_API_URL: this.apiUrl,
      },
    })

    // Log child output for debugging
    child.stdout?.on("data", (data) => {
      logger.info("Worker stdout", { jobId, output: data.toString().trim() })
    })
    child.stderr?.on("data", (data) => {
      logger.error("Worker stderr", { jobId, output: data.toString().trim() })
    })
    child.on("error", (err) => {
      logger.error("Worker spawn error", { jobId, error: err.message })
    })
    child.on("exit", (code, signal) => {
      logger.info("Worker exited", {
        "job.id": jobId,
        "worker.exit_code": code ?? undefined,
        "worker.signal": signal ?? undefined,
      })
    })

    // Unref so we don't wait for the child
    child.unref()

    logger.info("Local worker spawned", {
      jobId,
      pid: child.pid,
    })
  }

  async spawnScanner(scanJobId: string, scanToken: string): Promise<void> {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
    const scannerScript = resolve(repoRoot, "apps/runner/src/scanner.ts")

    logger.info("Spawning local scanner process", {
      scanJobId,
      apiUrl: this.apiUrl,
      scannerScript,
    })

    const child = spawn(process.execPath, ["--import", "tsx", scannerScript], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        YAFFLE_SCAN_JOB_ID: scanJobId,
        YAFFLE_JOB_TOKEN: scanToken,
        YAFFLE_API_URL: this.apiUrl,
      },
    })

    child.stdout?.on("data", (data) => {
      logger.info("Scanner stdout", { scanJobId, output: data.toString().trim() })
    })
    child.stderr?.on("data", (data) => {
      logger.error("Scanner stderr", { scanJobId, output: data.toString().trim() })
    })
    child.on("error", (err) => {
      logger.error("Scanner spawn error", { scanJobId, error: err.message })
    })
    child.on("exit", (code, signal) => {
      logger.info("Scanner exited", {
        "scan_job.id": scanJobId,
        "worker.exit_code": code ?? undefined,
        "worker.signal": signal ?? undefined,
      })
    })

    child.unref()

    logger.info("Local scanner spawned", {
      scanJobId,
      pid: child.pid,
    })
  }
}

/**
 * Factory function to create a local spawner with job token generation.
 *
 * This wraps the spawner to handle token generation, since the scheduler
 * needs to generate tokens before spawning.
 */
export function createLocalSpawner(config?: LocalSpawnerConfig): IacEngineSpawner {
  const spawner = new LocalChildProcessSpawner(config)

  return {
    async spawn(jobId: string, jobToken: string): Promise<void> {
      return spawner.spawn(jobId, jobToken)
    },
    async spawnScanner(scanJobId: string, scanToken: string): Promise<void> {
      return spawner.spawnScanner(scanJobId, scanToken)
    },
  }
}

/**
 * Generate a job token for a given job.
 *
 * This is called by the scheduler before spawning a worker.
 */
export async function generateJobTokenForJob(
  jobId: string,
  spawnLeaseToken?: string,
): Promise<string | null> {
  const job = await getJobWithContext(jobId)
  if (!job) {
    logger.error("Cannot generate job token: job not found", { jobId })
    return null
  }

  return generateJobToken(jobId, job.deployment.id, job.deployment.orgId, spawnLeaseToken)
}
