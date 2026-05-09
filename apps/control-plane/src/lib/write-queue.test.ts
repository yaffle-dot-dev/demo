import { describe, expect, test } from "@yaffle/test"

import { WriteQueue } from "./write-queue.ts"

describe("WriteQueue", () => {
  test("executes tasks sequentially", async () => {
    const queue = new WriteQueue()
    const order: number[] = []

    const p1 = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50))
      order.push(1)
    })

    const p2 = queue.enqueue(async () => {
      order.push(2)
    })

    const p3 = queue.enqueue(async () => {
      order.push(3)
    })

    await Promise.all([p1, p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  test("returns the result of each task", async () => {
    const queue = new WriteQueue()

    const r1 = queue.enqueue(async () => "first")
    const r2 = queue.enqueue(async () => 42)

    expect(await r1).toBe("first")
    expect(await r2).toBe(42)
  })

  test("error in one task does not block subsequent tasks", async () => {
    const queue = new WriteQueue()
    const results: string[] = []

    const p1 = queue.enqueue(async () => {
      results.push("before-error")
    })

    const p2 = queue.enqueue(async () => {
      throw new Error("boom")
    }).catch(() => {
      results.push("caught-error")
    })

    const p3 = queue.enqueue(async () => {
      results.push("after-error")
    })

    await Promise.all([p1, p2, p3])

    expect(results).toEqual(["before-error", "caught-error", "after-error"])
  })

  test("flush waits for all tasks", async () => {
    const queue = new WriteQueue()
    const results: number[] = []

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30))
      results.push(1)
    })

    queue.enqueue(async () => {
      results.push(2)
    })

    await queue.flush()
    expect(results).toEqual([1, 2])
  })

  test("size tracks pending tasks", async () => {
    const queue = new WriteQueue()
    expect(queue.size).toBe(0)

    let resolve1!: () => void
    const blocker = new Promise<void>((r) => { resolve1 = r })

    const p1 = queue.enqueue(async () => { await blocker })
    const p2 = queue.enqueue(async () => {})

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10))
    expect(queue.size).toBe(2)

    resolve1()
    await Promise.all([p1, p2])
    expect(queue.size).toBe(0)
  })
})
