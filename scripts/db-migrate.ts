import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { exec } from "./lib/exec"

export interface DbMigrateOptions {
  databaseUrl?: string
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

  // Check if there are pending migrations first
  console.log("Checking for pending migrations...")
  try {
    await exec(["bunx", "drizzle-kit", "check"], {
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
    await exec(["bunx", "drizzle-kit", "migrate"], {
      cwd: "apps/control-plane",
      env: { DATABASE_URL: rootDbUrl },
    })
  } catch {
    migrateFailed = true
    console.warn("drizzle-kit migrate exited non-zero; checking applied migration state")
  }

  const afterCount = await getAppliedMigrationCount(rootDbUrl)
  if (afterCount < expectedMigrationCount) {
    throw new Error(
      `Control-plane migrations incomplete: expected ${expectedMigrationCount}, found ${afterCount}`,
    )
  }

  if (migrateFailed && afterCount === beforeCount) {
    throw new Error("Control-plane migrations failed without applying any new migrations")
  }

  console.log("Migrations complete")
}

async function getExpectedMigrationCount(): Promise<number> {
  const journalPath = resolve(import.meta.dir, "../apps/control-plane/drizzle/meta/_journal.json")
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

  const output = await exec(["bun", "-e", script], {
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

if (import.meta.main) {
  await dbMigrate()
}
