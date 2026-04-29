import {
  deleteExpiredAnonymousPrincipalsBefore,
  expireInactiveAnonymousSessions,
} from "../db/queries/principals.ts"
import { DEFAULT_ANONYMOUS_SESSION_TTL_DAYS } from "../lib/principal-tokens.ts"

const ANONYMOUS_ARTIFACT_RETENTION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  const now = new Date()
  const expireBefore = new Date(now.getTime() - DEFAULT_ANONYMOUS_SESSION_TTL_DAYS * DAY_MS)
  const deleteBefore = new Date(
    now.getTime() - (DEFAULT_ANONYMOUS_SESSION_TTL_DAYS + ANONYMOUS_ARTIFACT_RETENTION_DAYS) * DAY_MS,
  )

  const expired = await expireInactiveAnonymousSessions(expireBefore)
  const deleted = await deleteExpiredAnonymousPrincipalsBefore(deleteBefore)

  console.log(
    JSON.stringify(
      {
        now: now.toISOString(),
        expireBefore: expireBefore.toISOString(),
        deleteBefore: deleteBefore.toISOString(),
        expired,
        deleted,
      },
      null,
      2,
    ),
  )
}

await main()
