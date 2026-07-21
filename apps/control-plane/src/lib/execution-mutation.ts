import { and, eq } from "drizzle-orm"

import { account } from "../db/auth-schema.ts"
import { principalRepoBindings, runGroups, tfRuns, workspaceDeployments } from "../db/schema.ts"
import { findOrgMembership } from "../db/queries/organizations.ts"
import { isUserAuthorizedApprover } from "./approver.ts"
import { db } from "./db.ts"
import { getEnv } from "./env.ts"
import {
  findExecutionSnapshotWorkspace,
  isExecutionContextAssociationValid,
} from "./execution-snapshot.ts"

export type ExecutionMutationAction = "apply" | "rerun" | "pause" | "cancel"
export type InfrastructureMutationAction = ExecutionMutationAction | "force_unlock"

export type ExecutionMutationActor =
  | {
      kind: "human"
      userId: string
      role: string
      apiKeyId?: string
    }
  | { kind: "scheduler" }

export interface ApplyDecision {
  version: 1
  action: "apply"
  source: "human" | "scheduler"
  actorUserId: string | null
  actorGithubLogin: string | null
  actorRole: string | null
  runGroupId: string
  planRunId: string
  workspacePath: string
  environmentKind: "named" | "transient"
  approvalRequired: boolean
  configuredApprovers: string[]
  configurationDigest: string
  decidedAt: string
  proof: string
}

export class ExecutionMutationDeniedError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "FORBIDDEN"
      | "APPROVER_NOT_AUTHORIZED"
      | "APPROVAL_POLICY_MISMATCH"
      | "EXECUTION_CONTEXT_INVALID",
  ) {
    super(message)
    this.name = "ExecutionMutationDeniedError"
  }
}

export async function authorizeExecutionMutation(values: {
  deploymentId: string
  runGroupId: string
  action: ExecutionMutationAction
  actor: ExecutionMutationActor
  planRunId?: string
}): Promise<{ applyDecision?: ApplyDecision }> {
  const context = (
    await db
      .select({
        deployment: workspaceDeployments,
        runGroup: runGroups,
        canonicalRepoNamespace: principalRepoBindings.canonicalRepoNamespace,
      })
      .from(workspaceDeployments)
      .innerJoin(runGroups, eq(runGroups.id, values.runGroupId))
      .leftJoin(principalRepoBindings, eq(principalRepoBindings.id, runGroups.repoBindingId))
      .where(eq(workspaceDeployments.id, values.deploymentId))
      .limit(1)
  )[0]

  if (
    !context?.runGroup.executionSnapshot ||
    context.deployment.runGroupId !== context.runGroup.id ||
    !isExecutionContextAssociationValid({
      snapshot: context.runGroup.executionSnapshot,
      runGroup: context.runGroup,
      resource: context.deployment,
      canonicalRepoNamespace: context.canonicalRepoNamespace,
      requireRepoBinding: context.deployment.environmentKind === "transient",
    })
  ) {
    throw new ExecutionMutationDeniedError(
      "deployment is not bound to a valid immutable execution context",
      "EXECUTION_CONTEXT_INVALID",
    )
  }

  const workspace = findExecutionSnapshotWorkspace(
    context.runGroup.executionSnapshot,
    context.deployment.workspacePath,
  )
  if (!workspace) {
    throw new ExecutionMutationDeniedError(
      "deployment workspace is missing from its immutable execution context",
      "EXECUTION_CONTEXT_INVALID",
    )
  }

  const snapshotApprovers = [...workspace.approval.approvers].sort()
  const projectedApprovers = Array.isArray(context.deployment.approvers)
    ? context.deployment.approvers
        .filter((approver): approver is string => typeof approver === "string")
        .sort()
    : []
  if (
    workspace.approval.required !== snapshotApprovers.length > 0 ||
    context.deployment.requireApproval !== workspace.approval.required ||
    snapshotApprovers.length !== projectedApprovers.length ||
    snapshotApprovers.some((approver, index) => approver !== projectedApprovers[index])
  ) {
    throw new ExecutionMutationDeniedError(
      "deployment approval projection does not match its immutable execution policy",
      "APPROVAL_POLICY_MISMATCH",
    )
  }

  let verifiedGithubLogin: string | null = null
  let verifiedActorRole: string | null = null
  if (values.actor.kind === "scheduler") {
    if (values.action !== "apply" || workspace.approval.required) {
      throw new ExecutionMutationDeniedError(
        "scheduler cannot perform this execution mutation",
        "FORBIDDEN",
      )
    }
  } else {
    const membership = await findOrgMembership(context.deployment.orgId, values.actor.userId)
    if (!membership) {
      throw new ExecutionMutationDeniedError("execution mutation org access denied", "FORBIDDEN")
    }
    verifiedActorRole = lowerPrivilegeRole(values.actor.role, membership.role)
    authorizeInfrastructureRole(values.action, verifiedActorRole)

    if (values.action === "apply" && workspace.approval.required) {
      const githubIdentity = values.actor.apiKeyId
        ? null
        : await resolveVerifiedGitHubIdentity(values.actor.userId)
      if (!githubIdentity) {
        throw new ExecutionMutationDeniedError(
          "a verified GitHub identity is required by the immutable approval policy",
          "APPROVER_NOT_AUTHORIZED",
        )
      }
      verifiedGithubLogin = githubIdentity.login
      const authorized = await isUserAuthorizedApprover(workspace.approval.approvers, {
        githubUsername: githubIdentity.login,
        installationId: context.runGroup.executionSnapshot.source.installationId,
      })
      if (!authorized) {
        throw new ExecutionMutationDeniedError(
          "approver is not authorized by the immutable approval policy",
          "APPROVER_NOT_AUTHORIZED",
        )
      }
    }
  }

  if (values.action !== "apply") {
    return {}
  }

  if (!values.planRunId) {
    throw new ExecutionMutationDeniedError(
      "apply authorization requires a successful plan run",
      "EXECUTION_CONTEXT_INVALID",
    )
  }
  const planRun = (
    await db
      .select({ id: tfRuns.id })
      .from(tfRuns)
      .where(
        and(
          eq(tfRuns.id, values.planRunId),
          eq(tfRuns.deploymentId, context.deployment.id),
          eq(tfRuns.runGroupId, context.runGroup.id),
          eq(tfRuns.runType, "plan"),
          eq(tfRuns.status, "success"),
        ),
      )
      .limit(1)
  )[0]
  if (!planRun) {
    throw new ExecutionMutationDeniedError(
      "apply authorization plan does not belong to the execution context",
      "EXECUTION_CONTEXT_INVALID",
    )
  }

  const unsignedDecision: Omit<ApplyDecision, "proof"> = {
    version: 1,
    action: "apply",
    source: values.actor.kind,
    actorUserId: values.actor.kind === "human" ? values.actor.userId : null,
    actorGithubLogin: verifiedGithubLogin,
    actorRole: verifiedActorRole,
    runGroupId: context.runGroup.id,
    planRunId: planRun.id,
    workspacePath: context.deployment.workspacePath,
    environmentKind: context.deployment.environmentKind as "named" | "transient",
    approvalRequired: workspace.approval.required,
    configuredApprovers: snapshotApprovers,
    configurationDigest: context.runGroup.executionSnapshot.configuration.digest,
    decidedAt: new Date().toISOString(),
  }
  return {
    applyDecision: {
      ...unsignedDecision,
      proof: signApplyDecision(unsignedDecision),
    },
  }
}

export function isApplyDecision(value: unknown): value is ApplyDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const decision = value as Partial<ApplyDecision>
  return (
    decision.version === 1 &&
    decision.action === "apply" &&
    (decision.source === "human" || decision.source === "scheduler") &&
    typeof decision.runGroupId === "string" &&
    typeof decision.planRunId === "string" &&
    typeof decision.workspacePath === "string" &&
    (decision.environmentKind === "named" || decision.environmentKind === "transient") &&
    typeof decision.approvalRequired === "boolean" &&
    Array.isArray(decision.configuredApprovers) &&
    decision.configuredApprovers.every((approver) => typeof approver === "string") &&
    typeof decision.configurationDigest === "string" &&
    typeof decision.decidedAt === "string" &&
    typeof decision.proof === "string" &&
    verifyApplyDecisionProof(decision as ApplyDecision)
  )
}

export function applyDecisionMatchesExecution(values: {
  decision: unknown
  runGroupId: string
  workspacePath: string
  environmentKind: string
  configurationDigest: string
  planRunId: string
  approval: { required: boolean; approvers: string[] }
}): boolean {
  if (!isApplyDecision(values.decision)) {
    return false
  }
  const configuredApprovers = [...values.approval.approvers].sort()
  return (
    values.decision.runGroupId === values.runGroupId &&
    values.decision.planRunId === values.planRunId &&
    values.decision.workspacePath === values.workspacePath &&
    values.decision.environmentKind === values.environmentKind &&
    values.decision.configurationDigest === values.configurationDigest &&
    values.decision.approvalRequired === values.approval.required &&
    values.decision.configuredApprovers.length === configuredApprovers.length &&
    values.decision.configuredApprovers.every(
      (approver, index) => approver === configuredApprovers[index],
    ) &&
    (!values.approval.required ||
      (values.decision.source === "human" &&
        values.decision.actorUserId !== null &&
        values.decision.actorGithubLogin !== null))
  )
}

export function authorizeInfrastructureRole(
  action: InfrastructureMutationAction,
  role: string,
): void {
  const allowed =
    action === "force_unlock" ? role === "admin" : role === "approver" || role === "admin"
  if (!allowed) {
    throw new ExecutionMutationDeniedError(
      action === "force_unlock"
        ? "force unlock requires admin role"
        : "execution mutations require approver role or higher",
      "FORBIDDEN",
    )
  }
}

function lowerPrivilegeRole(assertedRole: string, membershipRole: string): string {
  const rank: Record<string, number> = { viewer: 1, approver: 2, admin: 3 }
  const assertedRank = rank[assertedRole] ?? 0
  const membershipRank = rank[membershipRole] ?? 0
  return assertedRank <= membershipRank ? assertedRole : membershipRole
}

function signApplyDecision(decision: Omit<ApplyDecision, "proof">): string {
  return createHmac("sha256", getEnv().betterAuthSecret)
    .update(
      JSON.stringify([
        decision.version,
        decision.action,
        decision.source,
        decision.actorUserId,
        decision.actorGithubLogin,
        decision.actorRole,
        decision.runGroupId,
        decision.planRunId,
        decision.workspacePath,
        decision.environmentKind,
        decision.approvalRequired,
        decision.configuredApprovers,
        decision.configurationDigest,
        decision.decidedAt,
      ]),
    )
    .digest("base64url")
}

function verifyApplyDecisionProof(decision: ApplyDecision): boolean {
  const { proof, ...unsignedDecision } = decision
  const expected = Buffer.from(signApplyDecision(unsignedDecision))
  const provided = Buffer.from(proof)
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

async function resolveVerifiedGitHubIdentity(
  userId: string,
): Promise<{ id: string; login: string } | null> {
  const linkedAccounts = await db
    .select({ accountId: account.accountId, accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(2)
  if (linkedAccounts.length !== 1 || !linkedAccounts[0].accessToken) {
    return null
  }

  let response: Response
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${linkedAccounts[0].accessToken}`,
        "user-agent": "yaffle-control-plane",
        "x-github-api-version": "2022-11-28",
      },
    })
  } catch {
    return null
  }
  if (!response.ok) {
    return null
  }
  const profile = (await response.json().catch(() => null)) as {
    id?: unknown
    login?: unknown
  } | null
  if (
    !profile ||
    (typeof profile.id !== "number" && typeof profile.id !== "string") ||
    String(profile.id) !== linkedAccounts[0].accountId ||
    typeof profile.login !== "string" ||
    profile.login.length === 0
  ) {
    return null
  }
  return { id: linkedAccounts[0].accountId, login: profile.login }
}
import { createHmac, timingSafeEqual } from "node:crypto"
