/**
 * Interface for keyed mutexes that serialize async operations per key.
 * Operations for different keys run concurrently; operations for the
 * same key run sequentially.
 *
 * Implementations:
 * - KeyedMutex: in-memory, single-process (dev/test)
 * - PgAdvisoryMutex: PostgreSQL advisory locks, cross-process (production)
 */
export interface Mutex {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

/**
 * In-memory keyed mutex. Suitable for single-process dev/test setups.
 * For production with multiple instances, use PgAdvisoryMutex instead.
 */
export class KeyedMutex implements Mutex {
  private locks = new Map<string, Promise<void>>()

  /**
   * Run `fn` exclusively for the given key. If another operation is
   * already running for this key, wait for it to finish first.
   * Operations for different keys run concurrently.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Chain onto whatever is currently running for this key
    const prev = this.locks.get(key) ?? Promise.resolve()

    // Create a new promise that resolves when fn completes
    let release: () => void
    const lock = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(key, lock)

    // Wait for the previous operation to finish, then run ours
    await prev

    try {
      return await fn()
    } finally {
      release!()
      // Clean up the map entry if nothing else is queued
      if (this.locks.get(key) === lock) {
        this.locks.delete(key)
      }
    }
  }

  /** Number of keys with active or queued operations. For testing. */
  get size(): number {
    return this.locks.size
  }
}
