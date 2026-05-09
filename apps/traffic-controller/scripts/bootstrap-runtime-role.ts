import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildPsqlArgs,
  buildPutSecretValueArgs,
  buildRuntimeDatabaseUrl,
  getRuntimeRoleBootstrapEnv,
} from "../src/db-bootstrap.ts"

function runOrThrow(command: string[], executable: string): void {
  const result = spawnSync(executable, command, {
    stdio: "inherit",
  })

  if ((result.status ?? 1) !== 0) {
    throw new Error(`${executable} exited with code ${result.status ?? 1}`)
  }
}

const env = getRuntimeRoleBootstrapEnv()
const sqlFilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../sql/0001_runtime_role_grants.sql")

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
