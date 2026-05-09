import { describe, expect, test } from "@yaffle/test"

import { KeyedMutex } from "./mutex.ts"

describe("KeyedMutex", () => {
  test("runs a single operation", async () => {
    const mutex = new KeyedMutex()
    const result = await mutex.run("key-1", async () => 42)
    expect(result).toBe(42)
    expect(mutex.size).toBe(0)
  })

  test("serializes operations for the same key", async () => {
    const mutex = new KeyedMutex()
    const order: number[] = []

    // Create a controllable promise for the first operation
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const op1 = mutex.run("preview-1", async () => {
      order.push(1)
      await firstBlocked
      order.push(2)
      return "first"
    })

    const op2 = mutex.run("preview-1", async () => {
      order.push(3)
      return "second"
    })

    // op1 is running, op2 is waiting
    // Give microtasks a chance to settle
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([1])

    // Release op1
    releaseFirst()
    const [r1, r2] = await Promise.all([op1, op2])

    expect(r1).toBe("first")
    expect(r2).toBe("second")
    expect(order).toEqual([1, 2, 3])
    expect(mutex.size).toBe(0)
  })

  test("allows concurrent operations for different keys", async () => {
    const mutex = new KeyedMutex()
    const running: string[] = []

    let releaseA!: () => void
    let releaseB!: () => void
    const blockA = new Promise<void>((r) => { releaseA = r })
    const blockB = new Promise<void>((r) => { releaseB = r })

    const opA = mutex.run("preview-A", async () => {
      running.push("A-start")
      await blockA
      running.push("A-end")
    })

    const opB = mutex.run("preview-B", async () => {
      running.push("B-start")
      await blockB
      running.push("B-end")
    })

    // Both should start concurrently
    await new Promise((r) => setTimeout(r, 10))
    expect(running).toEqual(["A-start", "B-start"])

    releaseA()
    releaseB()
    await Promise.all([opA, opB])

    expect(running).toContain("A-end")
    expect(running).toContain("B-end")
    expect(mutex.size).toBe(0)
  })

  test("serializes three operations in order", async () => {
    const mutex = new KeyedMutex()
    const order: number[] = []

    const resolvers: Array<() => void> = []
    function makeBlocker(): Promise<void> {
      return new Promise((r) => resolvers.push(r))
    }

    const op1 = mutex.run("key", async () => {
      order.push(1)
      await makeBlocker()
    })
    const op2 = mutex.run("key", async () => {
      order.push(2)
      await makeBlocker()
    })
    const op3 = mutex.run("key", async () => {
      order.push(3)
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([1])

    // Release first
    resolvers[0]()
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([1, 2])

    // Release second
    resolvers[1]()
    await Promise.all([op1, op2, op3])
    expect(order).toEqual([1, 2, 3])
  })

  test("error in one operation does not block the next", async () => {
    const mutex = new KeyedMutex()

    const op1 = mutex.run("key", async () => {
      throw new Error("boom")
    }).catch((err) => err)

    const op2 = mutex.run("key", async () => {
      return "ok"
    })

    const [r1, r2] = await Promise.all([op1, op2])

    expect(r1).toBeInstanceOf(Error)
    expect((r1 as Error).message).toBe("boom")
    expect(r2).toBe("ok")
    expect(mutex.size).toBe(0)
  })
})
