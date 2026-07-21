export interface RuntimeRoleBootstrapEnv {
  adminDatabaseUrl: string
  runtimeRoleName: string
  runtimeRoleLoginName: string
  runtimeRolePassword: string
  runtimeDatabaseUrlSecretId: string
}

function extractBranchSuffixFromUsername(username: string): string {
  const trimmed = username.trim()
  const separatorIndex = trimmed.lastIndexOf(".")
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(
      "TRAFFIC_CONTROL_ADMIN_DATABASE_URL username must include a PlanetScale branch suffix (for example user.main)",
    )
  }

  return trimmed.slice(separatorIndex + 1)
}

export function cleanDatabaseUrl(raw: string): string {
  const url = new URL(raw)
  url.searchParams.delete("sslrootcert")
  if (url.searchParams.get("sslmode") === "verify-full") {
    url.searchParams.set("sslmode", "require")
  }
  return url.toString()
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? ""
  if (!value) {
    throw new Error(`${name} must be configured`)
  }

  return value
}

export function getRuntimeRoleBootstrapEnv(): RuntimeRoleBootstrapEnv {
  const adminDatabaseUrl = cleanDatabaseUrl(requireEnv("TRAFFIC_CONTROL_ADMIN_DATABASE_URL"))
  const runtimeRoleName =
    process.env.TRAFFIC_CONTROL_RUNTIME_ROLE_NAME?.trim() || "yaffle_tc_runtime"
  const branchSuffix = extractBranchSuffixFromUsername(new URL(adminDatabaseUrl).username)

  return {
    adminDatabaseUrl,
    runtimeRoleName,
    runtimeRoleLoginName: `${runtimeRoleName}.${branchSuffix}`,
    runtimeRolePassword: requireEnv("TRAFFIC_CONTROL_RUNTIME_ROLE_PASSWORD"),
    runtimeDatabaseUrlSecretId: requireEnv("TRAFFIC_CONTROL_DATABASE_URL_SECRET_ID"),
  }
}

export function buildRuntimeDatabaseUrl(params: {
  adminDatabaseUrl: string
  runtimeRoleLoginName: string
  runtimeRolePassword: string
}): string {
  const url = new URL(cleanDatabaseUrl(params.adminDatabaseUrl))
  url.username = params.runtimeRoleLoginName
  url.password = params.runtimeRolePassword
  return url.toString()
}

export function buildPsqlArgs(params: {
  sqlFilePath: string
  adminDatabaseUrl: string
  runtimeRoleName: string
  runtimeRolePassword: string
}): string[] {
  return [
    cleanDatabaseUrl(params.adminDatabaseUrl),
    "-v",
    `runtime_role=${params.runtimeRoleName}`,
    "-v",
    `runtime_password=${params.runtimeRolePassword}`,
    "-f",
    params.sqlFilePath,
  ]
}

export function buildPutSecretValueArgs(params: {
  secretId: string
  secretString: string
}): string[] {
  return [
    "secretsmanager",
    "put-secret-value",
    "--secret-id",
    params.secretId,
    "--secret-string",
    params.secretString,
  ]
}
