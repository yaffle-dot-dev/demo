import { and, eq, ne } from "drizzle-orm"

import { db } from "../lib/db.ts"
import { organizations, workspaceDeployments } from "../db/schema.ts"
import { rebuildEnvironmentGroupProjections } from "../lib/projections/environment-groups.ts"

function parseArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return null
  }

  return process.argv[index + 1] ?? null
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const orgSlug = parseArg("--org")

  const conditions = [ne(workspaceDeployments.status, "destroyed")]
  if (orgSlug) {
    conditions.push(eq(organizations.slug, orgSlug))
  }

  const rows = await db
    .select({
      orgId: workspaceDeployments.orgId,
      orgSlug: organizations.slug,
    })
    .from(workspaceDeployments)
    .innerJoin(organizations, eq(organizations.id, workspaceDeployments.orgId))
    .where(and(...conditions))

  const orgs = new Map<string, string>()
  for (const row of rows) {
    orgs.set(row.orgId, row.orgSlug)
  }

  console.log(`[backfill-environment-group-projections] orgs=${orgs.size}`)

  for (const [currentOrgId, currentOrgSlug] of orgs) {
    console.log(`- ${currentOrgSlug} (${currentOrgId})`)

    if (!apply) {
      continue
    }

    const namedCount = await rebuildEnvironmentGroupProjections({
      orgId: currentOrgId,
      environmentKind: "named",
    })
    const transientCount = await rebuildEnvironmentGroupProjections({
      orgId: currentOrgId,
      environmentKind: "transient",
    })

    console.log(`  named=${namedCount} transient=${transientCount}`)
  }
}

await main()
