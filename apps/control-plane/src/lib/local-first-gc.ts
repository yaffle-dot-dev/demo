import {
  deleteExpiredAnonymousPrincipalsBefore,
  expireInactiveAnonymousSessions,
} from "../db/queries/principals.ts"
import { getSchedulerRuntimeInfo } from "./scheduler.ts"
import { DEFAULT_ANONYMOUS_SESSION_TTL_DAYS } from "./principal-tokens.ts"
import { getLocalFirstGcRowsCounter, getLocalFirstGcRunsCounter, logger } from "./telemetry.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LOCAL_FIRST_GC_INTERVAL_MS = 60 * 60 * 1000
export const DEFAULT_ANONYMOUS_ARTIFACT_RETENTION_DAYS = 7

type LocalFirstGcState = {
  timer: ReturnType<typeof setInterval> | null
  intervalMs: number | null
}

export type LocalFirstGcResult = {
  now: string
  reason: string
  expireBefore: string
  deleteBefore: string
  expired: {
    principalCount: number
    sessionCount: number
  }
  deleted: {
    principalCount: number
    sessionCount: number
    repoBindingCount: number
    hostedOutputModuleCount: number
  }
}

function getLocalFirstGcState(): LocalFirstGcState {
  const globalKey = "__yaffle_local_first_gc_state"
  const globalRef = globalThis as Record<string, unknown>
  if (!globalRef[globalKey]) {
    globalRef[globalKey] = {
      timer: null,
      intervalMs: null,
    } as LocalFirstGcState
  }

  return globalRef[globalKey] as LocalFirstGcState
}

const state = getLocalFirstGcState()

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn("Invalid local-first GC interval override; using fallback", {
      variable: name,
      value: raw,
      fallback,
    })
    return fallback
  }

  return parsed
}

export function startLocalFirstGcLoop(): void {
  if (state.timer) {
    logger.warn("Local-first GC loop already running", {
      intervalMs: state.intervalMs ?? undefined,
    })
    return
  }

  const intervalMs = parsePositiveIntEnv(
    "YAFFLE_LOCAL_FIRST_GC_INTERVAL_MS",
    DEFAULT_LOCAL_FIRST_GC_INTERVAL_MS,
  )
  state.intervalMs = intervalMs

  logger.info("Starting local-first GC loop", { intervalMs })
  state.timer = setInterval(() => {
    void runLocalFirstGcIfLeader("interval")
  }, intervalMs)

  void runLocalFirstGcIfLeader("startup")
}

export function stopLocalFirstGcLoop(): void {
  if (!state.timer) {
    return
  }

  clearInterval(state.timer)
  state.timer = null
  logger.info("Stopped local-first GC loop", { intervalMs: state.intervalMs ?? undefined })
  state.intervalMs = null
}

export function getLocalFirstGcRuntimeInfo(): {
  running: boolean
  intervalMs: number | null
} {
  return {
    running: !!state.timer,
    intervalMs: state.intervalMs,
  }
}

export async function runLocalFirstGcIfLeader(reason: string): Promise<LocalFirstGcResult | null> {
  if (!getSchedulerRuntimeInfo().isLeader) {
    logger.debug(
      "Skipping local-first GC because this process does not hold scheduler leadership",
      {
        reason,
      },
    )
    return null
  }

  return runLocalFirstGcOnce(reason)
}

export async function runLocalFirstGcOnce(reason: string): Promise<LocalFirstGcResult> {
  const now = new Date()
  const expireBefore = new Date(now.getTime() - DEFAULT_ANONYMOUS_SESSION_TTL_DAYS * DAY_MS)
  const deleteBefore = new Date(
    now.getTime() -
      (DEFAULT_ANONYMOUS_SESSION_TTL_DAYS + DEFAULT_ANONYMOUS_ARTIFACT_RETENTION_DAYS) * DAY_MS,
  )

  try {
    const expired = await expireInactiveAnonymousSessions(expireBefore)
    const deleted = await deleteExpiredAnonymousPrincipalsBefore(deleteBefore)

    getLocalFirstGcRunsCounter().add(1, {
      result: "success",
      reason,
    })
    getLocalFirstGcRowsCounter().add(expired.principalCount, {
      phase: "expire",
      entity: "principal",
    })
    getLocalFirstGcRowsCounter().add(expired.sessionCount, {
      phase: "expire",
      entity: "session",
    })
    getLocalFirstGcRowsCounter().add(deleted.principalCount, {
      phase: "delete",
      entity: "principal",
    })
    getLocalFirstGcRowsCounter().add(deleted.sessionCount, {
      phase: "delete",
      entity: "session",
    })
    getLocalFirstGcRowsCounter().add(deleted.repoBindingCount, {
      phase: "delete",
      entity: "repo_binding",
    })
    getLocalFirstGcRowsCounter().add(deleted.hostedOutputModuleCount, {
      phase: "delete",
      entity: "hosted_output_module",
    })

    const result = {
      now: now.toISOString(),
      reason,
      expireBefore: expireBefore.toISOString(),
      deleteBefore: deleteBefore.toISOString(),
      expired,
      deleted,
    }

    logger.info("Local-first GC completed", {
      reason,
      expireBefore: result.expireBefore,
      deleteBefore: result.deleteBefore,
      expiredPrincipalCount: expired.principalCount,
      expiredSessionCount: expired.sessionCount,
      deletedPrincipalCount: deleted.principalCount,
      deletedSessionCount: deleted.sessionCount,
      deletedRepoBindingCount: deleted.repoBindingCount,
      deletedHostedOutputModuleCount: deleted.hostedOutputModuleCount,
    })

    return result
  } catch (error) {
    getLocalFirstGcRunsCounter().add(1, {
      result: "failed",
      reason,
    })
    logger.error("Local-first GC failed", {
      reason,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
