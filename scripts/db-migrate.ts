import { exec } from "./lib/exec"
import { isMain } from "./lib/module"

export interface DbMigrateOptions {
  databaseUrl?: string
}

export const REQUIRED_SCHEMA_COLUMNS = [
  "approvals.run_group_id",
  "iac_job_history.run_group_id",
  "iac_job_history.plan_purpose",
  "iac_job_history.apply_decision",
  "iac_job_history.target_state_version_id",
  "iac_job_history.target_workspace_id",
  "iac_jobs.run_group_id",
  "iac_jobs.plan_purpose",
  "iac_jobs.apply_decision",
  "iac_jobs.target_state_version_id",
  "iac_jobs.target_workspace_id",
  "run_groups.execution_snapshot",
  "scan_jobs.automatic_isolation_workspace_paths",
  "workspaces.environment_kind",
  "workspaces.environment_name",
  "tf_runs.plan_purpose",
  "tf_runs.target_state_version_id",
  "tf_runs.target_workspace_id",
] as const

export function assertRequiredSchema(missingColumns: string[]): void {
  if (missingColumns.length > 0) {
    throw new Error(`Control-plane schema incomplete: missing ${missingColumns.join(", ")}`)
  }
}

interface DbMigrateDependencies {
  run: typeof exec
  getMissingRequiredColumns: (databaseUrl: string) => Promise<string[]>
}

const defaultDependencies: DbMigrateDependencies = {
  run: exec,
  getMissingRequiredColumns,
}

function resolveDatabaseUrl(options: DbMigrateOptions): string {
  const databaseUrl =
    options.databaseUrl?.trim() ||
    process.env.YAFFLE_MIGRATION_DATABASE_URL?.trim() ||
    process.env.ROOT_DATABASE_URL?.trim()

  if (!databaseUrl) {
    throw new Error(
      "Set YAFFLE_MIGRATION_DATABASE_URL or ROOT_DATABASE_URL before running control-plane migrations",
    )
  }

  return databaseUrl
}

export async function dbMigrate(
  options: DbMigrateOptions = {},
  dependencies: DbMigrateDependencies = defaultDependencies,
): Promise<void> {
  const rootDbUrl = resolveDatabaseUrl(options)

  console.log("Running database migrations...")
  await dependencies.run(["vp", "exec", "drizzle-kit", "migrate"], {
    cwd: "apps/control-plane",
    env: { DATABASE_URL: rootDbUrl },
    quiet: true,
  })

  assertRequiredSchema(await dependencies.getMissingRequiredColumns(rootDbUrl))
  console.log("Migrations complete")
}

async function getMissingRequiredColumns(databaseUrl: string): Promise<string[]> {
  const script = [
    'import postgres from "postgres"',
    "const sql = postgres(process.env.DATABASE_URL)",
    `const required = ${JSON.stringify(REQUIRED_SCHEMA_COLUMNS)}`,
    "const rows = await sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`",
    "const existing = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))",
    "console.log(JSON.stringify(required.filter((column) => !existing.has(column))))",
    "await sql.end()",
  ].join("; ")

  const output = await exec(["node", "--input-type=module", "-e", script], {
    cwd: "apps/control-plane",
    env: { DATABASE_URL: databaseUrl },
    quiet: true,
  })
  const parsed = JSON.parse(output.trim()) as unknown
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`Unable to determine required schema columns from output: ${output.trim()}`)
  }
  return parsed
}

if (isMain(import.meta)) {
  await dbMigrate()
}
