/**
 * A keyed mutex that serializes async operations per key.
 *
 * Used to ensure only one webhook handler runs at a time per preview
 * (keyed by owner/repo/prNumber). Operations for different previews
 * run concurrently; operations for the same preview run sequentially
 * in arrival order.
 *
 * This is an in-memory solution suitable for a single-process dev setup.
 * In production with multiple API instances, this would be replaced by
 * DB advisory locks or a proper job queue with per-key ordering.
 */
export class KeyedMutex {
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
