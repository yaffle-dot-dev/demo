import { and, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { environmentPolicies } from "../schema.ts"

export type EnvironmentPolicy = typeof environmentPolicies.$inferSelect

export async function upsertEnvironmentPolicy(
  values: typeof environmentPolicies.$inferInsert,
): Promise<EnvironmentPolicy> {
  return withDbSpan("upsert", "environment_policies", async () => {
    const rows = await db
      .insert(environmentPolicies)
      .values(values)
      .onConflictDoUpdate({
        target: [
          environmentPolicies.orgId,
          environmentPolicies.repoFullName,
          environmentPolicies.environmentName,
        ],
        set: {
          minimumPrincipalTier: values.minimumPrincipalTier,
          lifecycleDispatch: values.lifecycleDispatch,
          allowedDestinationClasses: values.allowedDestinationClasses,
          updatedAt: new Date(),
        },
      })
      .returning()

    return rows[0]
  })
}

export async function findEnvironmentPolicy(values: {
  orgId: string
  repoFullName: string
  environmentName: string
}): Promise<EnvironmentPolicy | undefined> {
  return withDbSpan("select", "environment_policies", async () => {
    const rows = await db
      .select()
      .from(environmentPolicies)
      .where(
        and(
          eq(environmentPolicies.orgId, values.orgId),
          eq(environmentPolicies.repoFullName, values.repoFullName),
          eq(environmentPolicies.environmentName, values.environmentName),
        ),
      )
      .limit(1)
    return rows[0]
  })
}
