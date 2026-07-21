import { describe, expect, test } from "@yaffle/test"

import {
  buildPsqlArgs,
  buildPutSecretValueArgs,
  buildRuntimeDatabaseUrl,
  cleanDatabaseUrl,
} from "./db-bootstrap.ts"

describe("traffic-controller db bootstrap helpers", () => {
  test("normalizes admin urls for CLI and runtime usage", () => {
    expect(
      cleanDatabaseUrl(
        "postgresql://admin:secret@example.com:5432/postgres?sslmode=verify-full&sslrootcert=/Users/alex/.postgresql/root.crt",
      ),
    ).toBe("postgresql://admin:secret@example.com:5432/postgres?sslmode=require")
  })

  test("builds runtime database URL from admin URL", () => {
    const runtimeUrl = buildRuntimeDatabaseUrl({
      adminDatabaseUrl:
        "postgresql://admin.main:secret@example.com:5432/postgres?sslmode=verify-full&sslrootcert=/tmp/root.crt",
      runtimeRoleLoginName: "yaffle_tc_runtime.main",
      runtimeRolePassword: "super-secret-password",
    })

    expect(runtimeUrl).toBe(
      "postgresql://yaffle_tc_runtime.main:super-secret-password@example.com:5432/postgres?sslmode=require",
    )
  })

  test("builds branch-qualified runtime role args for psql", () => {
    expect(
      buildPsqlArgs({
        sqlFilePath: "/tmp/runtime-role.sql",
        adminDatabaseUrl: "postgresql://admin.main@example.com/postgres",
        runtimeRoleName: "yaffle_tc_runtime",
        runtimeRolePassword: "pw",
      }),
    ).toEqual([
      "postgresql://admin.main@example.com/postgres",
      "-v",
      "runtime_role=yaffle_tc_runtime",
      "-v",
      "runtime_password=pw",
      "-f",
      "/tmp/runtime-role.sql",
    ])
  })

  test("builds psql args with versioned sql file and runtime vars", () => {
    expect(
      buildPsqlArgs({
        sqlFilePath: "/tmp/runtime-role.sql",
        adminDatabaseUrl: "postgresql://admin@example.com/postgres",
        runtimeRoleName: "yaffle_tc_runtime",
        runtimeRolePassword: "pw",
      }),
    ).toEqual([
      "postgresql://admin@example.com/postgres",
      "-v",
      "runtime_role=yaffle_tc_runtime",
      "-v",
      "runtime_password=pw",
      "-f",
      "/tmp/runtime-role.sql",
    ])
  })

  test("builds aws secretsmanager put-secret-value args", () => {
    expect(
      buildPutSecretValueArgs({
        secretId: "yaffle/main/traffic-controller/database-url",
        secretString: "postgresql://runtime@example.com/postgres",
      }),
    ).toEqual([
      "secretsmanager",
      "put-secret-value",
      "--secret-id",
      "yaffle/main/traffic-controller/database-url",
      "--secret-string",
      "postgresql://runtime@example.com/postgres",
    ])
  })
})
