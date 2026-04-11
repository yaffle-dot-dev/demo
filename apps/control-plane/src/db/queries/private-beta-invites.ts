import { and, desc, eq, isNull, or } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { betaAccessInvites, user } from "../schema.ts"

export type BetaAccessInvite = typeof betaAccessInvites.$inferSelect

export interface ListedBetaAccessInvite {
  id: string
  email: string | null
  githubLogin: string | null
  note: string | null
  invitedByUserId: string | null
  invitedByName: string | null
  claimedByUserId: string | null
  claimedByName: string | null
  claimedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export function normalizeInviteEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase() ?? ""
  return value || null
}

export function normalizeGithubLogin(login: string | null | undefined): string | null {
  const value = login?.trim().replace(/^@+/, "").toLowerCase() ?? ""
  return value || null
}

export async function findPrivateBetaInviteById(id: string): Promise<BetaAccessInvite | undefined> {
  return withDbSpan("select", "beta_access_invites", async () => {
    const rows = await db
      .select()
      .from(betaAccessInvites)
      .where(eq(betaAccessInvites.id, id))
      .limit(1)

    return rows[0]
  })
}

export async function findPrivateBetaInviteByIdentity(input: {
  email?: string | null
  githubLogin?: string | null
}): Promise<BetaAccessInvite | undefined> {
  const email = normalizeInviteEmail(input.email)
  const githubLogin = normalizeGithubLogin(input.githubLogin)

  if (!email && !githubLogin) {
    return undefined
  }

  return withDbSpan("select", "beta_access_invites", async () => {
    const conditions = []
    if (email) conditions.push(eq(betaAccessInvites.email, email))
    if (githubLogin) conditions.push(eq(betaAccessInvites.githubLogin, githubLogin))

    const rows = await db
      .select()
      .from(betaAccessInvites)
      .where(or(...conditions))
      .limit(1)

    return rows[0]
  })
}

export async function findUsablePrivateBetaInviteForUser(input: {
  userId: string
  email?: string | null
  githubLogin?: string | null
}): Promise<BetaAccessInvite | undefined> {
  const email = normalizeInviteEmail(input.email)
  const githubLogin = normalizeGithubLogin(input.githubLogin)

  return withDbSpan("select", "beta_access_invites", async () => {
    const unclaimedConditions = []
    if (email) unclaimedConditions.push(eq(betaAccessInvites.email, email))
    if (githubLogin) unclaimedConditions.push(eq(betaAccessInvites.githubLogin, githubLogin))

    const rows = await db
      .select()
      .from(betaAccessInvites)
      .where(and(
        isNull(betaAccessInvites.revokedAt),
        or(
          eq(betaAccessInvites.claimedByUserId, input.userId),
          unclaimedConditions.length > 0
            ? and(isNull(betaAccessInvites.claimedByUserId), or(...unclaimedConditions))
            : eq(betaAccessInvites.claimedByUserId, input.userId),
        ),
      ))
      .orderBy(desc(betaAccessInvites.createdAt))
      .limit(1)

    return rows[0]
  })
}

export async function claimPrivateBetaInvite(input: {
  inviteId: string
  userId: string
}): Promise<BetaAccessInvite | undefined> {
  return withDbSpan("update", "beta_access_invites", async () => {
    const rows = await db
      .update(betaAccessInvites)
      .set({
        claimedByUserId: input.userId,
        claimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(betaAccessInvites.id, input.inviteId))
      .returning()

    return rows[0]
  })
}

export async function upsertPrivateBetaInvite(input: {
  email?: string | null
  githubLogin?: string | null
  note?: string | null
  invitedByUserId: string
}): Promise<BetaAccessInvite> {
  const email = normalizeInviteEmail(input.email)
  const githubLogin = normalizeGithubLogin(input.githubLogin)

  if (!email && !githubLogin) {
    throw new Error("email or githubLogin is required")
  }

  return withDbSpan("upsert", "beta_access_invites", async () => {
    const existing = await findPrivateBetaInviteByIdentity({ email, githubLogin })

    if (existing) {
      const rows = await db
        .update(betaAccessInvites)
        .set({
          email,
          githubLogin,
          note: input.note?.trim() || null,
          invitedByUserId: input.invitedByUserId,
          revokedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(betaAccessInvites.id, existing.id))
        .returning()

      return rows[0]
    }

    const rows = await db
      .insert(betaAccessInvites)
      .values({
        email,
        githubLogin,
        note: input.note?.trim() || null,
        invitedByUserId: input.invitedByUserId,
      })
      .returning()

    return rows[0]
  })
}

export async function revokePrivateBetaInvite(id: string): Promise<BetaAccessInvite | undefined> {
  return withDbSpan("update", "beta_access_invites", async () => {
    const rows = await db
      .update(betaAccessInvites)
      .set({
        revokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(betaAccessInvites.id, id))
      .returning()

    return rows[0]
  })
}

export async function listPrivateBetaInvites(): Promise<ListedBetaAccessInvite[]> {
  return withDbSpan("select", "beta_access_invites", async () => {
    const invitedBy = alias(user, "invited_by_user")
    const claimedBy = alias(user, "claimed_by_user")

    return db
      .select({
        id: betaAccessInvites.id,
        email: betaAccessInvites.email,
        githubLogin: betaAccessInvites.githubLogin,
        note: betaAccessInvites.note,
        invitedByUserId: betaAccessInvites.invitedByUserId,
        invitedByName: invitedBy.name,
        claimedByUserId: betaAccessInvites.claimedByUserId,
        claimedByName: claimedBy.name,
        claimedAt: betaAccessInvites.claimedAt,
        revokedAt: betaAccessInvites.revokedAt,
        createdAt: betaAccessInvites.createdAt,
        updatedAt: betaAccessInvites.updatedAt,
      })
      .from(betaAccessInvites)
      .leftJoin(invitedBy, eq(invitedBy.id, betaAccessInvites.invitedByUserId))
      .leftJoin(claimedBy, eq(claimedBy.id, betaAccessInvites.claimedByUserId))
      .orderBy(desc(betaAccessInvites.createdAt))
  })
}
