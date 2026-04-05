import { and, eq, gt, ne, sql } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import {
  logger,
  setRunnerWarmRunnersActiveValue,
  setRunnerWarmSlotsActiveValue,
  withDbSpan,
} from "../../lib/telemetry.ts"
import { warmRunnerSessions } from "../schema.ts"

export type WarmRunnerSession = typeof warmRunnerSessions.$inferSelect

function getWarmRunnerStaleCutoff(staleAfterMs: number): Date {
  return new Date(Date.now() - staleAfterMs)
}

async function refreshWarmRunnerGauges(staleAfterMs: number): Promise<void> {
  const staleCutoff = getWarmRunnerStaleCutoff(staleAfterMs)

  const [activeCountResult, activeSlotsResult] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(warmRunnerSessions)
      .where(
        and(
          eq(warmRunnerSessions.status, "active"),
          gt(warmRunnerSessions.lastHeartbeatAt, staleCutoff),
        ),
      ),
    db
      .select({ count: sql<number>`coalesce(sum(${warmRunnerSessions.activeSlots}), 0)::int` })
      .from(warmRunnerSessions)
      .where(
        and(
          eq(warmRunnerSessions.status, "active"),
          gt(warmRunnerSessions.lastHeartbeatAt, staleCutoff),
        ),
      ),
  ])

  setRunnerWarmRunnersActiveValue(activeCountResult[0]?.count ?? 0)
  setRunnerWarmSlotsActiveValue(activeSlotsResult[0]?.count ?? 0)
}

export async function registerWarmRunner(
  orgId: string,
  workerId: string,
  maxSlots: number,
  metadata?: Record<string, unknown>,
  staleAfterMs: number = 30_000,
): Promise<WarmRunnerSession> {
  return withDbSpan("insert", "warm_runner_sessions", async () => {
    const now = new Date()

    const rows = await db
      .insert(warmRunnerSessions)
      .values({
        orgId,
        workerId,
        status: "active",
        maxSlots,
        activeSlots: 0,
        metadata,
        lastHeartbeatAt: now,
        lastIdleAt: now,
        updatedAt: now,
      })
      .returning()

    const session = rows[0]
    await refreshWarmRunnerGauges(staleAfterMs)

    logger.info("warm_runner.registered", {
      "org.id": orgId,
      "runner.id": session.id,
      "worker.id": workerId,
      maxSlots,
    })

    return session
  })
}

export async function heartbeatWarmRunner(
  runnerId: string,
  orgId: string,
  workerId: string,
  activeSlots: number,
  staleAfterMs: number = 30_000,
): Promise<WarmRunnerSession | undefined> {
  return withDbSpan("update", "warm_runner_sessions", async () => {
    const now = new Date()

    const rows = await db
      .update(warmRunnerSessions)
      .set({
        activeSlots,
        lastHeartbeatAt: now,
        lastIdleAt: activeSlots === 0 ? now : warmRunnerSessions.lastIdleAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(warmRunnerSessions.id, runnerId),
          eq(warmRunnerSessions.orgId, orgId),
          eq(warmRunnerSessions.workerId, workerId),
          ne(warmRunnerSessions.status, "stopped"),
        ),
      )
      .returning()

    await refreshWarmRunnerGauges(staleAfterMs)
    return rows[0]
  })
}

export async function markWarmRunnerClaimedJob(
  runnerId: string,
  orgId: string,
  workerId: string,
  activeSlots: number,
  staleAfterMs: number = 30_000,
): Promise<WarmRunnerSession | undefined> {
  return withDbSpan("update", "warm_runner_sessions", async () => {
    const now = new Date()

    const rows = await db
      .update(warmRunnerSessions)
      .set({
        activeSlots,
        lastHeartbeatAt: now,
        lastClaimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(warmRunnerSessions.id, runnerId),
          eq(warmRunnerSessions.orgId, orgId),
          eq(warmRunnerSessions.workerId, workerId),
          eq(warmRunnerSessions.status, "active"),
        ),
      )
      .returning()

    await refreshWarmRunnerGauges(staleAfterMs)
    return rows[0]
  })
}

export async function hasActiveWarmRunnerForOrg(
  orgId: string,
  staleAfterMs: number = 30_000,
): Promise<boolean> {
  return withDbSpan("select", "warm_runner_sessions", async () => {
    const staleCutoff = getWarmRunnerStaleCutoff(staleAfterMs)

    const rows = await db
      .select({ id: warmRunnerSessions.id })
      .from(warmRunnerSessions)
      .where(
        and(
          eq(warmRunnerSessions.orgId, orgId),
          eq(warmRunnerSessions.status, "active"),
          gt(warmRunnerSessions.lastHeartbeatAt, staleCutoff),
        ),
      )
      .limit(1)

    return rows.length > 0
  })
}
