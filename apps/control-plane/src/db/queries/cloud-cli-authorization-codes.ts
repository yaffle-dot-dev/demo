import { createHash } from "node:crypto"

import { and, eq, gt } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { cloudCliAuthorizationCodes } from "../schema.ts"
import { withDbSpan } from "../../lib/telemetry.ts"

export type CloudCliAuthorizationCode = typeof cloudCliAuthorizationCodes.$inferSelect

export interface CreateCloudCliAuthorizationCodeInput {
  code: string
  userId: string
  codeChallenge: string
  codeChallengeMethod: string
  redirectUri: string
  expiresAt: Date
}

export function hashCloudCliAuthorizationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

export async function createCloudCliAuthorizationCode(
  input: CreateCloudCliAuthorizationCodeInput,
): Promise<void> {
  return withDbSpan("insert", "cloud_cli_authorization_codes", async () => {
    await db.insert(cloudCliAuthorizationCodes).values({
      codeHash: hashCloudCliAuthorizationCode(input.code),
      userId: input.userId,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      redirectUri: input.redirectUri,
      expiresAt: input.expiresAt,
    })
  })
}

export async function takeCloudCliAuthorizationCode(input: {
  code: string
  redirectUri: string
  codeChallenge: string
  now: Date
}): Promise<CloudCliAuthorizationCode | undefined> {
  return withDbSpan("delete", "cloud_cli_authorization_codes", async () => {
    const rows = await db
      .delete(cloudCliAuthorizationCodes)
      .where(
        and(
          eq(cloudCliAuthorizationCodes.codeHash, hashCloudCliAuthorizationCode(input.code)),
          eq(cloudCliAuthorizationCodes.redirectUri, input.redirectUri),
          eq(cloudCliAuthorizationCodes.codeChallenge, input.codeChallenge),
          gt(cloudCliAuthorizationCodes.expiresAt, input.now),
        ),
      )
      .returning()

    return rows[0]
  })
}
