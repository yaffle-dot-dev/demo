import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { exec } from "./lib/exec"
import { importMetaDir, isMain } from "./lib/module"

export interface DbMigrateOptions {
  databaseUrl?: string
}

export interface MigrationOutcome {
  expectedMigrationCount: number
  afterCount: number
}

export function hasPendingMigrations(
  expectedMigrationCount: number,
  appliedCount: number,
): boolean {
  return appliedCount < expectedMigrationCount
}

export function assertMigrationOutcome(outcome: MigrationOutcome): void {
  if (outcome.afterCount < outcome.expectedMigrationCount) {
    throw new Error(
      `Control-plane migrations incomplete: expected ${outcome.expectedMigrationCount}, found ${outcome.afterCount}`,
    )
  }
}

function resolveDatabaseUrl(options: DbMigrateOptions): string {
  const databaseUrl = options.databaseUrl?.trim()
    || process.env.YAFFLE_MIGRATION_DATABASE_URL?.trim()
    || process.env.ROOT_DATABASE_URL?.trim()

  if (!databaseUrl) {
    throw new Error(
      "Set YAFFLE_MIGRATION_DATABASE_URL or ROOT_DATABASE_URL before running control-plane migrations",
    )
  }

  return databaseUrl
}

export async function dbMigrate(options: DbMigrateOptions = {}) {
  const rootDbUrl = resolveDatabaseUrl(options)
  const expectedMigrationCount = await getExpectedMigrationCount()
  const beforeCount = await getAppliedMigrationCount(rootDbUrl)

  if (!hasPendingMigrations(expectedMigrationCount, beforeCount)) {
    console.log(
      `Migrations already current (${beforeCount}/${expectedMigrationCount}); skipping migrate`,
    )
    return
  }

  // Check if there are pending migrations first
  console.log("Checking for pending migrations...")
  try {
    await exec(["vp", "exec", "drizzle-kit", "check"], {
      cwd: "apps/control-plane",
      env: { DATABASE_URL: rootDbUrl },
      quiet: true,
    })
  } catch {
    // check failed — there may be issues, try to migrate anyway
  }

  console.log("Running database migrations...")
  let migrateFailed = false
  try {
    await exec(["vp", "exec", "drizzle-kit", "migrate"], {
      cwd: "apps/control-plane",
      env: { DATABASE_URL: rootDbUrl },
      quiet: true,
    })
  } catch (error) {
    migrateFailed = true
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `drizzle-kit migrate exited non-zero; checking applied migration state\n${message}`,
    )
  }

  const afterCount = await getAppliedMigrationCount(rootDbUrl)
  assertMigrationOutcome({ expectedMigrationCount, afterCount })

  if (migrateFailed) {
    console.warn(
      `drizzle-kit migrate failed, but another deploy applied all ${expectedMigrationCount} expected migrations; continuing`,
    )
  }

  console.log("Migrations complete")
}

async function getExpectedMigrationCount(): Promise<number> {
  const journalPath = resolve(importMetaDir(import.meta), "../apps/control-plane/drizzle/meta/_journal.json")
  const raw = await readFile(journalPath, "utf8")
  const journal = JSON.parse(raw) as { entries?: unknown[] }
  return Array.isArray(journal.entries) ? journal.entries.length : 0
}

async function getAppliedMigrationCount(databaseUrl: string): Promise<number> {
  const script = [
    'import postgres from "postgres"',
    'const sql = postgres(process.env.DATABASE_URL)',
    'const reg = await sql`select to_regclass(${"drizzle.__drizzle_migrations"}) as name`',
    'if (!reg[0]?.name) { console.log("0"); await sql.end(); process.exit(0) }',
    'const rows = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`',
    'console.log(String(rows[0]?.count ?? 0))',
    'await sql.end()',
  ].join("; ")

  const output = await exec(["node", "--input-type=module", "-e", script], {
    cwd: "apps/control-plane",
    env: { DATABASE_URL: databaseUrl },
    quiet: true,
  })

  const parsed = Number.parseInt(output.trim(), 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Unable to determine applied migration count from output: ${output.trim()}`)
  }

  return parsed
}

if (isMain(import.meta)) {
  await dbMigrate()
}
