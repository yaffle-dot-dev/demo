import { and, desc, eq, gt, isNull, or, type SQL } from "drizzle-orm"
import { createHash, randomBytes } from "node:crypto"

import { db } from "../../lib/db.ts"
import { apiTokens } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type ApiToken = typeof apiTokens.$inferSelect
export type NewApiToken = typeof apiTokens.$inferInsert

export interface ListApiTokensOptions {
  limit?: number
  cursor?: string
}

export const DEFAULT_TFC_TOKEN_TTL_DAYS = 30

export const TFC_SCOPES = {
  workspaceRead: "workspace:read",
  workspaceWrite: "workspace:write",
  workspaceLock: "workspace:lock",
  stateRead: "state:read",
  stateWrite: "state:write",
  stateDownload: "state:download",
  adminForceUnlock: "admin:force_unlock",
} as const

export type TfcTokenRole = "viewer" | "approver" | "admin"

export function getDefaultTfcScopesForRole(role: TfcTokenRole): string[] {
  if (role === "viewer") {
    return [TFC_SCOPES.workspaceRead, TFC_SCOPES.stateRead, TFC_SCOPES.stateDownload]
  }

  if (role === "approver") {
    return [
      TFC_SCOPES.workspaceRead,
      TFC_SCOPES.workspaceWrite,
      TFC_SCOPES.workspaceLock,
      TFC_SCOPES.stateRead,
      TFC_SCOPES.stateWrite,
      TFC_SCOPES.stateDownload,
    ]
  }

  return [
    TFC_SCOPES.workspaceRead,
    TFC_SCOPES.workspaceWrite,
    TFC_SCOPES.workspaceLock,
    TFC_SCOPES.stateRead,
    TFC_SCOPES.stateWrite,
    TFC_SCOPES.stateDownload,
    TFC_SCOPES.adminForceUnlock,
  ]
}

export function getDefaultTfcTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_TFC_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * Hash a token for storage. We use SHA-256 for fast lookups.
 * Note: bcrypt is more secure for passwords, but for API tokens
 * we need fast lookups and the tokens are high-entropy random strings.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Generate a new API token.
 * Returns both the plain token (to return to user once) and the hash (to store).
 */
export function generateToken(): { token: string; hash: string } {
  // Generate 32 bytes of randomness, encode as base64url
  const token = randomBytes(32).toString("base64url")
  const hash = hashToken(token)
  return { token, hash }
}

/**
 * Find an API token by its UUID.
 */
export async function findApiTokenById(id: string): Promise<ApiToken | undefined> {
  return withDbSpan("select", "api_tokens", async () => {
    const rows = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .limit(1)
    return rows[0]
  })
}

/**
 * Find an API token by its hash. Used during authentication.
 * Only returns non-expired tokens.
 */
export async function findApiTokenByHash(tokenHash: string): Promise<ApiToken | undefined> {
  return withDbSpan("select", "api_tokens", async () => {
    const now = new Date()
    const rows = await db
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.tokenHash, tokenHash),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
        ),
      )
      .limit(1)
    return rows[0]
  })
}

/**
 * List API tokens for a user (without exposing the hashes).
 */
export async function listApiTokens(
  userId: string,
  opts: ListApiTokensOptions = {},
): Promise<{ items: Omit<ApiToken, "tokenHash">[]; nextCursor: string | null }> {
  return withDbSpan("select", "api_tokens", async () => {
    const limit = Math.min(opts.limit ?? 50, 250)
    const conditions: SQL[] = [eq(apiTokens.userId, userId)]

    if (opts.cursor) {
      conditions.push(gt(apiTokens.createdAt, new Date(opts.cursor)))
    }

    const rows = await db
      .select({
        id: apiTokens.id,
        userId: apiTokens.userId,
        orgId: apiTokens.orgId,
        description: apiTokens.description,
        scopes: apiTokens.scopes,
        createdByFlow: apiTokens.createdByFlow,
        lastUsedAt: apiTokens.lastUsedAt,
        expiresAt: apiTokens.expiresAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(...conditions))
      .orderBy(desc(apiTokens.createdAt))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null

    return { items, nextCursor }
  })
}

/**
 * Create a new API token.
 * Returns the created token record (with hash) - the plain token should be
 * generated separately and returned to the user.
 */
export async function createApiToken(values: NewApiToken): Promise<ApiToken> {
  return withDbSpan("insert", "api_tokens", async () => {
    const rows = await db.insert(apiTokens).values(values).returning()
    return rows[0]
  })
}

/**
 * Update the last_used_at timestamp for a token.
 */
export async function touchApiToken(tokenId: string): Promise<void> {
  return withDbSpan("update", "api_tokens", async () => {
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tokenId))
  })
}

/**
 * Delete an API token.
 */
export async function deleteApiToken(tokenId: string, userId: string): Promise<boolean> {
  return withDbSpan("delete", "api_tokens", async () => {
    const rows = await db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
      .returning({ id: apiTokens.id })
    return rows.length > 0
  })
}

/**
 * Delete all API tokens for a user.
 * Used for cleanup in tests.
 */
export async function deleteApiTokensByUserId(userId: string): Promise<number> {
  return withDbSpan("delete", "api_tokens", async () => {
    const rows = await db
      .delete(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .returning({ id: apiTokens.id })
    return rows.length
  })
}
