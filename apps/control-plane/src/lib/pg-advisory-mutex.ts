import postgres from "postgres"

import type { Mutex } from "./mutex.ts"

/**
 * Cross-process keyed mutex backed by PostgreSQL session-level advisory locks.
 *
 * Uses a dedicated connection pool (separate from the main query pool) so that
 * holding a lock during long-running work (git clone, S3 upload) does not
 * starve normal database queries.
 *
 * Each `run()` call reserves a connection, acquires `pg_advisory_lock` on a
 * hash of the key, executes the callback, then unlocks and releases the
 * connection. Locks for different keys can be held concurrently (up to
 * `poolSize` connections). Locks for the same key serialize across all
 * processes sharing the same database.
 */
export class PgAdvisoryMutex implements Mutex {
  private pool: ReturnType<typeof postgres>

  constructor(connectionString: string, poolSize = 3) {
    this.pool = postgres(connectionString, {
      max: poolSize,
      idle_timeout: 30,
      connect_timeout: 10,
    })
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const connection = await this.pool.reserve()
    try {
      await connection`SELECT pg_advisory_lock(hashtext(${key})::bigint)`
      try {
        return await fn()
      } finally {
        await connection`SELECT pg_advisory_unlock(hashtext(${key})::bigint)`
      }
    } finally {
      connection.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
