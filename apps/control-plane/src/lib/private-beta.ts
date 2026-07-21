import { listUserOrgs } from "../db/queries/users.ts"
import {
  findUsablePrivateBetaInviteForUser,
  normalizeGithubLogin,
} from "../db/queries/private-beta-invites.ts"

export interface PrivateBetaAccessStatus {
  invitesRequired: boolean
  hasAccess: boolean
  isOperator: boolean
  accessReason: "disabled" | "operator" | "existing_member" | "invited" | "not_invited"
  matchedBy: "claimed" | "email" | "github_login" | null
  invite: {
    id: string
    email: string | null
    githubLogin: string | null
    claimedAt: Date | null
    revokedAt: Date | null
  } | null
}

function parseCsvIdentifiers(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function arePrivateBetaInvitesRequired(): boolean {
  return process.env.YAFFLE_PRIVATE_BETA_INVITES_REQUIRED === "true"
}

export function isPrivateBetaOperator(input: {
  email?: string | null
  githubLogin?: string | null
}): boolean {
  const identifiers = new Set(
    parseCsvIdentifiers(process.env.YAFFLE_PRIVATE_BETA_OPERATOR_IDENTIFIERS),
  )
  if (identifiers.size === 0) {
    return false
  }

  const email = input.email?.trim().toLowerCase() ?? ""
  const githubLogin = normalizeGithubLogin(input.githubLogin) ?? ""

  return identifiers.has(email) || identifiers.has(githubLogin)
}

export async function getPrivateBetaAccessStatusForUser(input: {
  userId: string
  email?: string | null
  githubLogin?: string | null
}): Promise<PrivateBetaAccessStatus> {
  const invitesRequired = arePrivateBetaInvitesRequired()
  const operator = isPrivateBetaOperator(input)

  if (!invitesRequired) {
    return {
      invitesRequired,
      hasAccess: true,
      isOperator: operator,
      accessReason: "disabled",
      matchedBy: null,
      invite: null,
    }
  }

  if (operator) {
    return {
      invitesRequired,
      hasAccess: true,
      isOperator: true,
      accessReason: "operator",
      matchedBy: null,
      invite: null,
    }
  }

  const existingOrgs = await listUserOrgs(input.userId)
  if (existingOrgs.length > 0) {
    return {
      invitesRequired,
      hasAccess: true,
      isOperator: false,
      accessReason: "existing_member",
      matchedBy: null,
      invite: null,
    }
  }

  const invite = await findUsablePrivateBetaInviteForUser(input)
  if (!invite) {
    return {
      invitesRequired,
      hasAccess: false,
      isOperator: false,
      accessReason: "not_invited",
      matchedBy: null,
      invite: null,
    }
  }

  const matchedBy =
    invite.claimedByUserId === input.userId
      ? "claimed"
      : invite.email?.trim().toLowerCase() === input.email?.trim().toLowerCase()
        ? "email"
        : "github_login"

  return {
    invitesRequired,
    hasAccess: true,
    isOperator: false,
    accessReason: "invited",
    matchedBy,
    invite: {
      id: invite.id,
      email: invite.email,
      githubLogin: invite.githubLogin,
      claimedAt: invite.claimedAt,
      revokedAt: invite.revokedAt,
    },
  }
}
