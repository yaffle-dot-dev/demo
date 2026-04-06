#!/usr/bin/env bun

import { randomUUID } from "node:crypto"

import { RunnerApiClient } from "./lib/api-client.ts"
import { runClaimedJob } from "./lib/run-claimed-job.ts"
import { WarmRunnerApiClient } from "./lib/warm-runner-api-client.ts"
import { error, log } from "./lib/runner-log.ts"

const RUNNER_TOKEN = process.env.YAFFLE_WARM_RUNNER_TOKEN
const API_URL = process.env.YAFFLE_API_URL
const MAX_SLOTS = Number.parseInt(process.env.YAFFLE_WARM_RUNNER_MAX_SLOTS ?? "1", 10)

async function main(): Promise<void> {
  if (!RUNNER_TOKEN) {
    error("YAFFLE_WARM_RUNNER_TOKEN not set")
    process.exit(1)
  }

  if (!API_URL) {
    error("YAFFLE_API_URL not set")
    process.exit(1)
  }

  if (!Number.isFinite(MAX_SLOTS) || MAX_SLOTS < 1 || MAX_SLOTS > 4) {
    error("Invalid warm runner max slots", { maxSlots: MAX_SLOTS })
    process.exit(1)
  }

  const workerId = `warm-runner-${process.pid}-${randomUUID().slice(0, 8)}`
  const apiClient = new WarmRunnerApiClient({
    apiUrl: API_URL,
    runnerToken: RUNNER_TOKEN,
  })

  const registration = await apiClient.register(workerId, MAX_SLOTS, {
    hostname: process.env.HOSTNAME ?? "unknown",
      pid: process.pid,
      mode: MAX_SLOTS === 1 ? "warm-single-slot" : "warm-multi-slot",
    })

  log("Warm runner registered", {
    workerId,
    runnerId: registration.runnerId,
    orgId: registration.orgId,
    pollIntervalMs: registration.pollIntervalMs,
    heartbeatIntervalMs: registration.heartbeatIntervalMs,
      idleShutdownMs: registration.idleShutdownMs,
      maxSlots: registration.maxSlots,
    })

  let activeSlots = 0
  let lastWorkAt = Date.now()
  const activeJobs = new Set<Promise<void>>()

  const waitForSlot = async (): Promise<void> => {
    while (activeSlots >= registration.maxSlots) {
      if (activeJobs.size === 0) {
        break
      }

      await Promise.race(activeJobs)
    }
  }

  const trackJob = (promise: Promise<void>): void => {
    activeJobs.add(promise)
    void promise.finally(() => {
      activeJobs.delete(promise)
    })
  }

  const heartbeatTimer = setInterval(() => {
    void apiClient.heartbeat(registration.runnerId, workerId, activeSlots).catch((err) => {
      error("Warm runner heartbeat failed", {
        workerId,
        runnerId: registration.runnerId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, registration.heartbeatIntervalMs)

  try {
    while (true) {
      await waitForSlot()

      const availableSlots = Math.max(1, registration.maxSlots - activeSlots)
      const claim = await apiClient.claimNext(registration.runnerId, workerId, availableSlots)

      if (!claim.claimed || !claim.job || !claim.runId || !claim.jobToken) {
        if (activeSlots === 0 && Date.now() - lastWorkAt >= registration.idleShutdownMs) {
          log("Warm runner idle shutdown", {
            workerId,
            runnerId: registration.runnerId,
            idleShutdownMs: registration.idleShutdownMs,
          })
          break
        }

        await apiClient.heartbeat(registration.runnerId, workerId, activeSlots)
        await Bun.sleep(registration.pollIntervalMs)
        continue
      }

      activeSlots += 1
      lastWorkAt = Date.now()

      await apiClient.heartbeat(registration.runnerId, workerId, activeSlots)

      const claimedJob = claim.job
      const runId = claim.runId
      const jobToken = claim.jobToken

      log("Warm runner claimed job", {
        workerId,
        runnerId: registration.runnerId,
        jobId: claimedJob.id,
        jobType: claimedJob.jobType,
        runId,
        activeSlots,
        maxSlots: registration.maxSlots,
      })

      const jobApiClient = new RunnerApiClient({
        apiUrl: API_URL,
        jobToken,
        jobId: claimedJob.id,
      })

      const jobPromise = (async () => {
        const result = await runClaimedJob({
          apiClient: jobApiClient,
          jobId: claimedJob.id,
          runId,
          workerId,
        })

        activeSlots = Math.max(0, activeSlots - 1)
        lastWorkAt = Date.now()

        log("Warm runner finished job", {
          workerId,
          runnerId: registration.runnerId,
          jobId: claimedJob.id,
          success: result.success,
          activeSlots,
          maxSlots: registration.maxSlots,
        })

        await apiClient.heartbeat(registration.runnerId, workerId, activeSlots)
      })()

      trackJob(jobPromise)
    }
  } finally {
    clearInterval(heartbeatTimer)
    if (activeJobs.size > 0) {
      await Promise.allSettled(Array.from(activeJobs))
    }
  }
}

main().catch((err) => {
  error("Unhandled exception in warm runner", {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
