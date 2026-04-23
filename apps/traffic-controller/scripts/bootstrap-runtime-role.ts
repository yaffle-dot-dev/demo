import { resolve } from "node:path"

import {
  buildPsqlArgs,
  buildPutSecretValueArgs,
  buildRuntimeDatabaseUrl,
  getRuntimeRoleBootstrapEnv,
} from "../src/db-bootstrap.ts"

function runOrThrow(command: string[], executable: string): void {
  const result = Bun.spawnSync([executable, ...command], {
    stdout: "inherit",
    stderr: "inherit",
  })

  if (result.exitCode !== 0) {
    throw new Error(`${executable} exited with code ${result.exitCode}`)
  }
}

const env = getRuntimeRoleBootstrapEnv()
const sqlFilePath = resolve(import.meta.dir, "../sql/0001_runtime_role_grants.sql")

runOrThrow(buildPsqlArgs({
  sqlFilePath,
  adminDatabaseUrl: env.adminDatabaseUrl,
  runtimeRoleName: env.runtimeRoleName,
  runtimeRolePassword: env.runtimeRolePassword,
}), "psql")

const runtimeDatabaseUrl = buildRuntimeDatabaseUrl({
  adminDatabaseUrl: env.adminDatabaseUrl,
  runtimeRoleLoginName: env.runtimeRoleLoginName,
  runtimeRolePassword: env.runtimeRolePassword,
})

runOrThrow(buildPutSecretValueArgs({
  secretId: env.runtimeDatabaseUrlSecretId,
  secretString: runtimeDatabaseUrl,
}), "aws")

console.log(`Bootstrapped traffic-controller runtime role '${env.runtimeRoleName}' and updated secret '${env.runtimeDatabaseUrlSecretId}'.`)
