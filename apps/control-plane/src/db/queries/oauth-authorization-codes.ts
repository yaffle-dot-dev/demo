import { createHash } from "node:crypto"

import { eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { oauthAuthorizationCodes } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type OauthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect

export interface CreateOauthAuthorizationCodeInput {
  code: string
  userId: string
  orgId: string
  orgSlug: string
  scopes: string[]
  codeChallenge: string
  codeChallengeMethod: string
  redirectUri: string
  expiresAt: Date
}

export function hashOauthAuthorizationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

export async function createOauthAuthorizationCode(
  input: CreateOauthAuthorizationCodeInput,
): Promise<void> {
  return withDbSpan("insert", "oauth_authorization_codes", async () => {
    await db.insert(oauthAuthorizationCodes).values({
      codeHash: hashOauthAuthorizationCode(input.code),
      userId: input.userId,
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      scopes: input.scopes,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      redirectUri: input.redirectUri,
      expiresAt: input.expiresAt,
    })
  })
}

export async function takeOauthAuthorizationCode(
  code: string,
): Promise<OauthAuthorizationCode | undefined> {
  return withDbSpan("delete", "oauth_authorization_codes", async () => {
    const rows = await db
      .delete(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, hashOauthAuthorizationCode(code)))
      .returning()

    return rows[0]
  })
}
