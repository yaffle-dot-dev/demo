/**
 * Distributed lease-based mutex using a database table.
 *
 * Works correctly with pgbouncer and connection pooling (unlike advisory locks
 * which are session-scoped and break when connections are reused).
 *
 * Two usage patterns:
 *
 * 1. **Short-lived mutex** (`run`): Acquire a lease, run a function, release.
 *    If the process dies, the lease expires and unblocks other waiters.
 *
 * 2. **Long-lived leader election** (`acquire`/`release`): Acquire a lease and
 *    renew it periodically. Other instances wait for the lease to expire.
 *    Call `release()` for immediate handoff, or let it expire on crash.
 */

import { eq, sql } from "drizzle-orm"

import { db } from "./db.ts"
import { leases } from "../db/schema.ts"
import type { Mutex } from "./mutex.ts"
import { logger } from "./telemetry.ts"

/** Default lease TTL for short-lived mutex operations */
const MUTEX_LEASE_TTL_MS = 30_000

/** How long to wait between acquire retries for `run()` */
const MUTEX_RETRY_INTERVAL_MS = 200

export interface LeaseHandle {
  /** Stop renewing and release the lease */
  release(): Promise<void>
}

/**
 * Try to acquire a lease for the given key.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < NOW() so that:
 * - If no row exists, the lease is created
 * - If the row exists but is expired, the lease is taken over
 * - If the row exists and is still valid, the upsert is a no-op (returns no rows)
 */
async function tryAcquire(
  key: string,
  holderId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await db.execute(
    sql`INSERT INTO leases (key, holder_id, acquired_at, renewed_at, expires_at)
     VALUES (${key}, ${holderId}, NOW(), NOW(), NOW() + ${sql.raw(`INTERVAL '${ttlMs} milliseconds'`)})
     ON CONFLICT (key) DO UPDATE
       SET holder_id = ${holderId},
           acquired_at = NOW(),
           renewed_at = NOW(),
           expires_at = NOW() + ${sql.raw(`INTERVAL '${ttlMs} milliseconds'`)}
       WHERE leases.expires_at < NOW()
     RETURNING key`,
  ) as unknown as { key: string }[]

  return result.length > 0
}

/**
 * Acquire a long-lived lease with automatic renewal.
 *
 * Returns a handle to release the lease, or null if another holder has it.
 * The lease is renewed at `ttlMs / 3` intervals — if renewal fails or the
 * process dies, the lease expires after `ttlMs` and another instance can claim.
 */
export async function acquireLease(
  key: string,
  holderId: string,
  ttlMs: number,
): Promise<LeaseHandle | null> {
  const acquired = await tryAcquire(key, holderId, ttlMs)
  if (!acquired) {
    return null
  }

  const renewInterval = Math.floor(ttlMs / 3)
  const timer = setInterval(() => {
    db.update(leases)
      .set({
        renewedAt: new Date(),
        expiresAt: new Date(Date.now() + ttlMs),
      })
      .where(eq(leases.holderId, holderId))
      .then(() => {
        // If holderId changed, the next renewal will also be a no-op
      })
      .catch((err) => {
        logger.error("Failed to renew lease", {
          key,
          holderId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, renewInterval)

  return {
    async release() {
      clearInterval(timer)
      try {
        await db.delete(leases).where(eq(leases.holderId, holderId))
      } catch {
        // If delete fails, the lease will expire naturally
      }
    },
  }
}

/**
 * Lease-backed distributed mutex. Drop-in replacement for PgAdvisoryMutex.
 *
 * Implements the Mutex interface: `run(key, fn)` acquires a lease, runs fn,
 * then releases. If the process dies mid-fn, the lease expires after `ttlMs`.
 */
export class DbLeaseMutex implements Mutex {
  private readonly holderId: string
  private readonly ttlMs: number

  constructor(holderId: string, ttlMs = MUTEX_LEASE_TTL_MS) {
    this.holderId = holderId
    this.ttlMs = ttlMs
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const leaseKey = `mutex:${key}`

    // Spin until we acquire the lease
    while (true) {
      const acquired = await tryAcquire(leaseKey, this.holderId, this.ttlMs)
      if (acquired) break
      await new Promise((resolve) => setTimeout(resolve, MUTEX_RETRY_INTERVAL_MS))
    }

    try {
      return await fn()
    } finally {
      // Release immediately so the next waiter doesn't have to wait for expiry
      try {
        await db.delete(leases).where(eq(leases.key, leaseKey))
      } catch {
        // Lease will expire naturally
      }
    }
  }
}
