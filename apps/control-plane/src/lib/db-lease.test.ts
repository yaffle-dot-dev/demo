import { afterEach, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"

import { leases } from "../db/schema.ts"
import { db } from "./db.ts"
import { DbLeaseMutex } from "./db-lease.ts"

const leaseKey = `renewing-mutex-${crypto.randomUUID()}`

afterEach(async () => {
  await db.delete(leases).where(eq(leases.key, `mutex:${leaseKey}`))
})

test("renews a mutex lease until the protected operation completes", async () => {
  const events: string[] = []
  const firstMutex = new DbLeaseMutex("first", 60)
  const secondMutex = new DbLeaseMutex("second", 60)

  const first = firstMutex.run(leaseKey, async () => {
    events.push("first-start")
    await new Promise((resolve) => setTimeout(resolve, 150))
    events.push("first-end")
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const second = secondMutex.run(leaseKey, async () => {
    events.push("second-start")
  })

  await Promise.all([first, second])
  expect(events).toEqual(["first-start", "first-end", "second-start"])
})
