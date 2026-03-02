import { desc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { approvals } from "../schema.ts"

export type Approval = typeof approvals.$inferSelect
export type NewApproval = typeof approvals.$inferInsert

/**
 * Create an approval record.
 */
export async function createApproval(values: NewApproval): Promise<Approval> {
  const rows = await db.insert(approvals).values(values).returning()
  return rows[0]
}

/**
 * List approvals for a preview.
 */
export async function listApprovals(previewId: string): Promise<Approval[]> {
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.previewId, previewId))
    .orderBy(desc(approvals.approvedAt))
}
