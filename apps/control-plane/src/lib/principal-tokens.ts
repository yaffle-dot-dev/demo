import { SignJWT, jwtVerify, type JWTPayload } from "jose"

import { getEnv } from "./env.ts"

export const DEFAULT_ANONYMOUS_SESSION_TTL_DAYS = 14
export const DEFAULT_ACCOUNT_PRINCIPAL_TOKEN_TTL_DAYS = 30
export const DEFAULT_EXECUTION_TOKEN_TTL_MINUTES = 15
export const DEFAULT_SHELL_SESSION_EXECUTION_TOKEN_TTL_MINUTES = 4 * 60

export interface AnonymousSessionTokenPayload extends JWTPayload {
  token_type: "anonymous_session"
  principal_id: string
  session_id: string
}

export interface AccountPrincipalTokenPayload extends JWTPayload {
  token_type: "account_principal"
  principal_id: string
  user_id: string
}

export interface ExecutionTokenPayload extends JWTPayload {
  token_type: "execution"
  principal_id: string
  session_id?: string
  repo_binding_id: string
  canonical_repo_namespace: string
  environment_name: string
  consumer_workspace_path: string
  scopes: string[]
}

function getJwtSecret(variableName: string): Uint8Array {
  const env = getEnv()
  const secret = process.env[variableName] ?? env.betterAuthSecret
  if (!secret) {
    throw new Error(`${variableName} or BETTER_AUTH_SECRET must be configured`)
  }

  return new TextEncoder().encode(secret)
}

export async function generateAnonymousSessionToken(params: {
  principalId: string
  sessionId: string
  ttlDays?: number
}): Promise<string> {
  return new SignJWT({
    token_type: "anonymous_session",
    principal_id: params.principalId,
    session_id: params.sessionId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`principal:${params.principalId}`)
    .setIssuedAt()
    .setExpirationTime(`${params.ttlDays ?? DEFAULT_ANONYMOUS_SESSION_TTL_DAYS}d`)
    .sign(getJwtSecret("YAFFLE_PRINCIPAL_TOKEN_SECRET"))
}

export async function verifyAnonymousSessionToken(
  token: string,
): Promise<AnonymousSessionTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret("YAFFLE_PRINCIPAL_TOKEN_SECRET"))
    if (
      payload.sub?.startsWith("principal:") !== true ||
      payload.token_type !== "anonymous_session" ||
      typeof payload.principal_id !== "string" ||
      typeof payload.session_id !== "string"
    ) {
      return null
    }

    return payload as AnonymousSessionTokenPayload
  } catch {
    return null
  }
}

export async function generateAccountPrincipalToken(params: {
  principalId: string
  userId: string
  ttlDays?: number
}): Promise<string> {
  return new SignJWT({
    token_type: "account_principal",
    principal_id: params.principalId,
    user_id: params.userId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`principal:${params.principalId}`)
    .setIssuedAt()
    .setExpirationTime(`${params.ttlDays ?? DEFAULT_ACCOUNT_PRINCIPAL_TOKEN_TTL_DAYS}d`)
    .sign(getJwtSecret("YAFFLE_PRINCIPAL_TOKEN_SECRET"))
}

export async function verifyAccountPrincipalToken(
  token: string,
): Promise<AccountPrincipalTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret("YAFFLE_PRINCIPAL_TOKEN_SECRET"))
    if (
      payload.sub?.startsWith("principal:") !== true ||
      payload.token_type !== "account_principal" ||
      typeof payload.principal_id !== "string" ||
      typeof payload.user_id !== "string"
    ) {
      return null
    }

    return payload as AccountPrincipalTokenPayload
  } catch {
    return null
  }
}

export async function generateExecutionToken(params: {
  principalId: string
  sessionId?: string
  repoBindingId: string
  canonicalRepoNamespace: string
  environmentName: string
  consumerWorkspacePath: string
  scopes?: string[]
  ttlMinutes?: number
}): Promise<string> {
  return new SignJWT({
    token_type: "execution",
    principal_id: params.principalId,
    ...(params.sessionId ? { session_id: params.sessionId } : {}),
    repo_binding_id: params.repoBindingId,
    canonical_repo_namespace: params.canonicalRepoNamespace,
    environment_name: params.environmentName,
    consumer_workspace_path: params.consumerWorkspacePath,
    scopes: params.scopes ?? ["module:read"],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`principal:${params.principalId}`)
    .setIssuedAt()
    .setExpirationTime(`${params.ttlMinutes ?? DEFAULT_EXECUTION_TOKEN_TTL_MINUTES}m`)
    .sign(getJwtSecret("YAFFLE_EXECUTION_TOKEN_SECRET"))
}

export async function verifyExecutionToken(token: string): Promise<ExecutionTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret("YAFFLE_EXECUTION_TOKEN_SECRET"))
    if (
      payload.sub?.startsWith("principal:") !== true ||
      payload.token_type !== "execution" ||
      typeof payload.principal_id !== "string" ||
      (payload.session_id !== undefined && typeof payload.session_id !== "string") ||
      typeof payload.repo_binding_id !== "string" ||
      typeof payload.canonical_repo_namespace !== "string" ||
      typeof payload.environment_name !== "string" ||
      typeof payload.consumer_workspace_path !== "string" ||
      !Array.isArray(payload.scopes)
    ) {
      return null
    }

    return payload as ExecutionTokenPayload
  } catch {
    return null
  }
}

export function buildHostedModuleVersion(versionSerial: number): string {
  return `1.0.${versionSerial}`
}

export function parseHostedModuleVersion(version: string): number | null {
  const match = version.match(/^1\.0\.(\d+)$/)
  if (!match) {
    return null
  }
  return Number.parseInt(match[1], 10)
}
