import { asc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { connections } from "../schema.ts"

export type Connection = typeof connections.$inferSelect
export type NewConnection = typeof connections.$inferInsert

export async function listConnectionsForOrg(orgId: string): Promise<Connection[]> {
  return withDbSpan("select", "connections", async () => {
    return db
      .select()
      .from(connections)
      .where(eq(connections.orgId, orgId))
      .orderBy(asc(connections.name), asc(connections.createdAt))
  })
}

export async function findConnectionById(connectionId: string): Promise<Connection | undefined> {
  return withDbSpan("select", "connections", async () => {
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1)
    return rows[0]
  })
}

export async function createConnection(values: NewConnection): Promise<Connection> {
  return withDbSpan("insert", "connections", async () => {
    const rows = await db.insert(connections).values(values).returning()
    return rows[0]
  })
}

export async function updateConnection(
  connectionId: string,
  values: Partial<NewConnection>,
): Promise<Connection | undefined> {
  return withDbSpan("update", "connections", async () => {
    const rows = await db
      .update(connections)
      .set({
        ...values,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .returning()

    return rows[0]
  })
}

export async function deleteConnection(connectionId: string): Promise<void> {
  return withDbSpan("delete", "connections", async () => {
    await db
      .delete(connections)
      .where(eq(connections.id, connectionId))
  })
}
