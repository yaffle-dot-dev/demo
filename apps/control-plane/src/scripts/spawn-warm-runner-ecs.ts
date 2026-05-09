#!/usr/bin/env node

import { findOrgById, findOrgBySlug } from "../db/queries/organizations.ts"
import { createEcsSpawner } from "../lib/ecs-spawner.ts"
import { generateWarmRunnerToken } from "../lib/job-token.ts"

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

const identifier = process.argv[2]
const maxSlotsArg = process.argv[3]
const ttlArg = process.argv[4]

if (!identifier) {
  console.error(
    "Usage: pnpm exec tsx src/scripts/spawn-warm-runner-ecs.ts <org-id-or-slug> [max-slots] [ttl-hours]",
  )
  process.exit(1)
}

const maxSlots = maxSlotsArg ? Number.parseInt(maxSlotsArg, 10) : 2
if (!Number.isFinite(maxSlots) || maxSlots < 1 || maxSlots > 4) {
  console.error(`Invalid max-slots: ${maxSlotsArg}`)
  process.exit(1)
}

const ttlHours = ttlArg ? Number.parseInt(ttlArg, 10) : 12
if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
  console.error(`Invalid ttl-hours: ${ttlArg}`)
  process.exit(1)
}

const org = looksLikeUuid(identifier)
  ? (await findOrgById(identifier)) ?? (await findOrgBySlug(identifier))
  : await findOrgBySlug(identifier)

if (!org) {
  console.error(`Organization not found: ${identifier}`)
  process.exit(1)
}

const token = await generateWarmRunnerToken(org.id, ttlHours)
const spawner = createEcsSpawner()
const taskArn = await spawner.spawnWarmRunner({
  orgId: org.id,
  orgSlug: org.slug,
  runnerToken: token,
  maxSlots,
})

console.log(JSON.stringify({
  orgId: org.id,
  orgSlug: org.slug,
  maxSlots,
  ttlHours,
  taskArn,
}, null, 2))
