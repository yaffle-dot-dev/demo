import { createHash } from "node:crypto"

import { and, desc, eq, inArray } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import {
  lifecycleCompletionTokens,
  lifecycleEvents,
  lifecycleItems,
  lifecycleRuns,
  principalRepoBindings,
} from "../schema.ts"

export type LifecycleRun = typeof lifecycleRuns.$inferSelect
export type LifecycleItem = typeof lifecycleItems.$inferSelect
export type LifecycleEvent = typeof lifecycleEvents.$inferSelect

export function hashLifecycleCompletionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export async function createLifecycleRun(
  values: typeof lifecycleRuns.$inferInsert,
): Promise<LifecycleRun> {
  return withDbSpan("insert", "lifecycle_runs", async () => {
    const rows = await db.insert(lifecycleRuns).values(values).returning()
    return rows[0]
  })
}

export async function updateLifecycleRun(
  runId: string,
  values: Partial<typeof lifecycleRuns.$inferInsert>,
): Promise<LifecycleRun | undefined> {
  return withDbSpan("update", "lifecycle_runs", async () => {
    const rows = await db
      .update(lifecycleRuns)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(lifecycleRuns.id, runId))
      .returning()
    return rows[0]
  })
}

export async function findLifecycleRunById(runId: string): Promise<LifecycleRun | undefined> {
  return withDbSpan("select", "lifecycle_runs", async () => {
    const rows = await db.select().from(lifecycleRuns).where(eq(lifecycleRuns.id, runId)).limit(1)
    return rows[0]
  })
}

export async function findLifecycleRunByRunGroupId(
  runGroupId: string,
): Promise<LifecycleRun | undefined> {
  return withDbSpan("select", "lifecycle_runs", async () => {
    const rows = await db
      .select()
      .from(lifecycleRuns)
      .where(eq(lifecycleRuns.runGroupId, runGroupId))
      .orderBy(desc(lifecycleRuns.createdAt))
      .limit(1)
    return rows[0]
  })
}

export async function createLifecycleItem(
  values: typeof lifecycleItems.$inferInsert,
): Promise<LifecycleItem> {
  return withDbSpan("insert", "lifecycle_items", async () => {
    const rows = await db.insert(lifecycleItems).values(values).returning()
    return rows[0]
  })
}

export async function updateLifecycleItem(
  itemId: string,
  values: Partial<typeof lifecycleItems.$inferInsert>,
): Promise<LifecycleItem | undefined> {
  return withDbSpan("update", "lifecycle_items", async () => {
    const rows = await db
      .update(lifecycleItems)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(lifecycleItems.id, itemId))
      .returning()
    return rows[0]
  })
}

export async function createLifecycleEvent(
  values: typeof lifecycleEvents.$inferInsert,
): Promise<LifecycleEvent> {
  return withDbSpan("insert", "lifecycle_events", async () => {
    const rows = await db.insert(lifecycleEvents).values(values).returning()
    return rows[0]
  })
}

export async function listLifecycleEventsForItems(itemIds: string[]): Promise<LifecycleEvent[]> {
  if (itemIds.length === 0) {
    return []
  }

  return withDbSpan("select", "lifecycle_events", async () => {
    return db
      .select()
      .from(lifecycleEvents)
      .where(inArray(lifecycleEvents.itemId, itemIds))
      .orderBy(lifecycleEvents.createdAt)
  })
}

export async function issueLifecycleCompletionToken(values: {
  token: string
  itemId: string
  expiresAt: Date
}): Promise<void> {
  return withDbSpan("insert", "lifecycle_completion_tokens", async () => {
    await db.insert(lifecycleCompletionTokens).values({
      tokenHash: hashLifecycleCompletionToken(values.token),
      itemId: values.itemId,
      expiresAt: values.expiresAt,
    })
  })
}

export async function consumeLifecycleCompletionToken(
  token: string,
  options: { consume?: boolean } = {},
): Promise<
  | {
      token: typeof lifecycleCompletionTokens.$inferSelect
      item: LifecycleItem
      run: LifecycleRun
    }
  | undefined
> {
  return withDbSpan("update", "lifecycle_completion_tokens", async () => {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ token: lifecycleCompletionTokens, item: lifecycleItems, run: lifecycleRuns })
        .from(lifecycleCompletionTokens)
        .innerJoin(lifecycleItems, eq(lifecycleItems.id, lifecycleCompletionTokens.itemId))
        .innerJoin(lifecycleRuns, eq(lifecycleRuns.id, lifecycleItems.runId))
        .where(eq(lifecycleCompletionTokens.tokenHash, hashLifecycleCompletionToken(token)))
        .limit(1)

      const row = rows[0]
      if (!row || row.token.usedAt || row.token.expiresAt.getTime() <= Date.now()) {
        return undefined
      }

      if (options.consume ?? true) {
        await tx
          .update(lifecycleCompletionTokens)
          .set({ usedAt: new Date() })
          .where(eq(lifecycleCompletionTokens.tokenHash, row.token.tokenHash))
      }

      return row
    })
  })
}

export async function findLifecycleItemById(itemId: string): Promise<LifecycleItem | undefined> {
  return withDbSpan("select", "lifecycle_items", async () => {
    const rows = await db
      .select()
      .from(lifecycleItems)
      .where(eq(lifecycleItems.id, itemId))
      .limit(1)
    return rows[0]
  })
}

export async function listLifecycleItemsForRun(runId: string): Promise<LifecycleItem[]> {
  return withDbSpan("select", "lifecycle_items", async () => {
    return db
      .select()
      .from(lifecycleItems)
      .where(eq(lifecycleItems.runId, runId))
      .orderBy(lifecycleItems.workspacePath, lifecycleItems.key)
  })
}

export async function findLatestLifecycleRun(values: {
  repoBindingId: string
  environmentName: string
}): Promise<LifecycleRun | undefined> {
  return withDbSpan("select", "lifecycle_runs", async () => {
    const rows = await db
      .select()
      .from(lifecycleRuns)
      .where(
        and(
          eq(lifecycleRuns.repoBindingId, values.repoBindingId),
          eq(lifecycleRuns.environmentName, values.environmentName),
        ),
      )
      .orderBy(desc(lifecycleRuns.createdAt))
      .limit(1)
    return rows[0]
  })
}

export async function getLatestLifecycleState(values: {
  repoBindingId: string
  environmentName: string
}): Promise<{ run: LifecycleRun; items: LifecycleItem[] } | undefined> {
  return withDbSpan("select", "lifecycle_runs", async () => {
    const run = await findLatestLifecycleRun(values)
    if (!run) {
      return undefined
    }
    const items = await listLifecycleItemsForRun(run.id)
    return { run, items }
  })
}

export async function getLatestLifecycleStateForRepoEnvironment(values: {
  canonicalRepoNamespace: string
  environmentName: string
}): Promise<{ run: LifecycleRun; items: LifecycleItem[] } | undefined> {
  return withDbSpan("select", "lifecycle_runs", async () => {
    const rows = await db
      .select({ run: lifecycleRuns })
      .from(lifecycleRuns)
      .innerJoin(principalRepoBindings, eq(principalRepoBindings.id, lifecycleRuns.repoBindingId))
      .where(
        and(
          eq(principalRepoBindings.canonicalRepoNamespace, values.canonicalRepoNamespace),
          eq(lifecycleRuns.environmentName, values.environmentName),
        ),
      )
      .orderBy(desc(lifecycleRuns.createdAt))
      .limit(1)

    const run = rows[0]?.run
    if (!run) {
      return undefined
    }

    const items = await listLifecycleItemsForRun(run.id)
    return { run, items }
  })
}

export async function getLifecycleStateForRunGroup(runGroupId: string): Promise<
  | {
      run: LifecycleRun
      items: LifecycleItem[]
    }
  | undefined
> {
  return withDbSpan("select", "lifecycle_runs", async () => {
    const run = await findLifecycleRunByRunGroupId(runGroupId)
    if (!run) {
      return undefined
    }

    const items = await listLifecycleItemsForRun(run.id)
    return { run, items }
  })
}
