/**
 * A serialized async task queue. Tasks are executed one at a time in
 * arrival order, regardless of how many are enqueued concurrently.
 *
 * Used by PrCommentManager to prevent concurrent GitHub API writes
 * to the same comment.
 */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  /**
   * Enqueue a task. Returns a promise that resolves when the task completes.
   * If the task throws, the error propagates to the caller but does NOT
   * block subsequent tasks in the queue.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++

    // Capture the current tail so we can chain after it
    const prev = this.tail

    // Create a deferred for the caller to await
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    // Extend the tail: run fn after previous completes, always resolve the
    // tail itself so subsequent tasks are never blocked by a failure
    this.tail = prev.then(async () => {
      try {
        const result = await fn()
        resolve(result)
      } catch (err) {
        reject(err)
      } finally {
        this.pending--
      }
    })

    return promise
  }

  /** Number of tasks currently enqueued (including the one running). */
  get size(): number {
    return this.pending
  }

  /** Wait for all enqueued tasks to complete. */
  async flush(): Promise<void> {
    await this.tail
  }
}
