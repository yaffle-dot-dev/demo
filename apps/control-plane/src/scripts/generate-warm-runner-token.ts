#!/usr/bin/env node

import { findOrgById, findOrgBySlug } from "../db/queries/organizations.ts"
import { generateWarmRunnerToken } from "../lib/job-token.ts"

const identifier = process.argv[2]
const ttlArg = process.argv[3]

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

if (!identifier) {
  console.error(
    "Usage: pnpm exec tsx src/scripts/generate-warm-runner-token.ts <org-id-or-slug> [ttl-hours]",
  )
  process.exit(1)
}

const ttlHours = ttlArg ? Number.parseInt(ttlArg, 10) : 12
if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
  console.error(`Invalid ttl-hours: ${ttlArg}`)
  process.exit(1)
}

const resolvedOrg = looksLikeUuid(identifier)
  ? ((await findOrgById(identifier)) ?? (await findOrgBySlug(identifier)))
  : await findOrgBySlug(identifier)
if (!resolvedOrg) {
  console.error(`Organization not found: ${identifier}`)
  process.exit(1)
}

const token = await generateWarmRunnerToken(resolvedOrg.id, ttlHours)

console.log(
  JSON.stringify(
    {
      orgId: resolvedOrg.id,
      orgSlug: resolvedOrg.slug,
      ttlHours,
      token,
      exportLine: `YAFFLE_WARM_RUNNER_TOKEN="${token}"`,
    },
    null,
    2,
  ),
)
