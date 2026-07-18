import { describe, expect, test } from "@yaffle/test"

import { assertMigrationOutcome, hasPendingMigrations } from "./db-migrate.ts"

describe("assertMigrationOutcome", () => {
  test("skips migrate when every migration was already applied", () => {
    expect(hasPendingMigrations(42, 42)).toBe(false)
  })

  test("runs migrate when the database is behind", () => {
    expect(hasPendingMigrations(42, 41)).toBe(true)
  })

  test("accepts a migration completed by another concurrent deploy", () => {
    expect(() =>
      assertMigrationOutcome({ expectedMigrationCount: 42, afterCount: 42 }),
    ).not.toThrow()
  })

  test("rejects a migration attempt that leaves migrations unapplied", () => {
    expect(() =>
      assertMigrationOutcome({
        expectedMigrationCount: 42,
        afterCount: 41,
      }),
    ).toThrow("Control-plane migrations incomplete: expected 42, found 41")
  })
})
