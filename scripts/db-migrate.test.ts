import { describe, expect, test } from "@yaffle/test"

import { assertRequiredSchema, dbMigrate, REQUIRED_SCHEMA_COLUMNS } from "./db-migrate.ts"

describe("assertRequiredSchema", () => {
  test("covers the physical schema required by migrations 0030-0036", () => {
    expect(REQUIRED_SCHEMA_COLUMNS).toEqual([
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
    ])
  })

  test("rejects migration history that does not match the physical schema", () => {
    expect(() => assertRequiredSchema(["run_groups.execution_snapshot"])).toThrow(
      "Control-plane schema incomplete: missing run_groups.execution_snapshot",
    )
  })

  test("accepts a complete physical schema", () => {
    expect(() => assertRequiredSchema([])).not.toThrow()
  })
})

describe("dbMigrate", () => {
  test("propagates drizzle migration failures without inspecting migration counts", async () => {
    await expect(
      dbMigrate(
        { databaseUrl: "postgresql://migration.test/postgres" },
        {
          run: async () => {
            throw new Error("drizzle failed")
          },
          getMissingRequiredColumns: async () => {
            throw new Error("schema check must not run")
          },
        },
      ),
    ).rejects.toThrow("drizzle failed")
  })

  test("checks the physical schema after drizzle succeeds", async () => {
    await expect(
      dbMigrate(
        { databaseUrl: "postgresql://migration.test/postgres" },
        {
          run: async () => "",
          getMissingRequiredColumns: async () => ["run_groups.execution_snapshot"],
        },
      ),
    ).rejects.toThrow("Control-plane schema incomplete")
  })

  test("runs drizzle once with the privileged URL and then checks that database", async () => {
    const commands: Array<{ command: string[]; databaseUrl: string | undefined }> = []
    const checkedUrls: string[] = []

    await dbMigrate(
      { databaseUrl: "postgresql://migration.test/postgres" },
      {
        run: async (command, options) => {
          commands.push({ command, databaseUrl: options?.env?.DATABASE_URL })
          return ""
        },
        getMissingRequiredColumns: async (databaseUrl) => {
          checkedUrls.push(databaseUrl)
          return []
        },
      },
    )

    expect(commands).toEqual([
      {
        command: ["vp", "exec", "drizzle-kit", "migrate"],
        databaseUrl: "postgresql://migration.test/postgres",
      },
    ])
    expect(checkedUrls).toEqual(["postgresql://migration.test/postgres"])
  })
})
