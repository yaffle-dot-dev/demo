import { afterAll, describe, expect, test } from "bun:test"

import { PgAdvisoryMutex } from "./pg-advisory-mutex.ts"

const connectionString = process.env.DATABASE_URL ?? "postgresql://yaffle@localhost:5432/yaffle_dev"

describe("PgAdvisoryMutex", () => {
  const mutex = new PgAdvisoryMutex(connectionString, 3)

  afterAll(async () => {
    await mutex.close()
  })

  test("runs a single operation", async () => {
    const result = await mutex.run("test-single", async () => 42)
    expect(result).toBe(42)
  })

  test("serializes operations for the same key", async () => {
    const order: number[] = []

    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const op1 = mutex.run("same-key", async () => {
      order.push(1)
      await firstBlocked
      order.push(2)
      return "first"
    })

    // Give op1 time to acquire the lock
    await new Promise((r) => setTimeout(r, 50))

    const op2 = mutex.run("same-key", async () => {
      order.push(3)
      return "second"
    })

    // op2 should be blocked — only op1 has started
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual([1])

    // Release op1
    releaseFirst()
    const [r1, r2] = await Promise.all([op1, op2])

    expect(r1).toBe("first")
    expect(r2).toBe("second")
    expect(order).toEqual([1, 2, 3])
  })

  test("allows concurrent operations for different keys", async () => {
    const running: string[] = []

    let releaseA!: () => void
    let releaseB!: () => void
    const blockA = new Promise<void>((r) => { releaseA = r })
    const blockB = new Promise<void>((r) => { releaseB = r })

    const opA = mutex.run("key-A", async () => {
      running.push("A-start")
      await blockA
      running.push("A-end")
    })

    const opB = mutex.run("key-B", async () => {
      running.push("B-start")
      await blockB
      running.push("B-end")
    })

    // Both should start concurrently
    await new Promise((r) => setTimeout(r, 50))
    expect(running).toEqual(["A-start", "B-start"])

    releaseA()
    releaseB()
    await Promise.all([opA, opB])

    expect(running).toContain("A-end")
    expect(running).toContain("B-end")
  })

  test("releases lock on error so next operation can proceed", async () => {
    const op1 = mutex.run("error-key", async () => {
      throw new Error("boom")
    }).catch((err) => err)

    const result = await op1
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe("boom")

    // Lock should be released — a subsequent run with the same key should succeed
    const op2Result = await mutex.run("error-key", async () => "recovered")
    expect(op2Result).toBe("recovered")
  })
})
