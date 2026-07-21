import { relations } from "drizzle-orm/relations"
import {
  user,
  account,
  session,
  organizations,
  githubInstallations,
  orgMemberships,
  connections,
  workspaceDeployments,
  tfRuns,
  runGroups,
  approvals,
  jobs,
  repositories,
  workspaces,
  stateVersions,
  apiTokens,
  iacJobs,
} from "./schema"

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}))

export const userRelations = relations(user, ({ many }) => ({
  accounts: many(account),
  sessions: many(session),
  orgMemberships: many(orgMemberships),
  approvals: many(approvals),
  apiTokens: many(apiTokens),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}))

export const githubInstallationsRelations = relations(githubInstallations, ({ one }) => ({
  organization: one(organizations, {
    fields: [githubInstallations.orgId],
    references: [organizations.id],
  }),
}))

export const organizationsRelations = relations(organizations, ({ many }) => ({
  githubInstallations: many(githubInstallations),
  orgMemberships: many(orgMemberships),
  connections: many(connections),
  jobs: many(jobs),
  repositories: many(repositories),
  workspaces: many(workspaces),
  workspaceDeployments: many(workspaceDeployments),
  runGroups: many(runGroups),
}))

export const orgMembershipsRelations = relations(orgMemberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgMemberships.orgId],
    references: [organizations.id],
  }),
  user: one(user, {
    fields: [orgMemberships.userId],
    references: [user.id],
  }),
}))

export const connectionsRelations = relations(connections, ({ one }) => ({
  organization: one(organizations, {
    fields: [connections.orgId],
    references: [organizations.id],
  }),
}))

export const tfRunsRelations = relations(tfRuns, ({ one, many }) => ({
  workspaceDeployment: one(workspaceDeployments, {
    fields: [tfRuns.previewId],
    references: [workspaceDeployments.id],
  }),
  runGroup: one(runGroups, {
    fields: [tfRuns.runGroupId],
    references: [runGroups.id],
  }),
  stateVersions: many(stateVersions),
}))

export const workspaceDeploymentsRelations = relations(workspaceDeployments, ({ one, many }) => ({
  tfRuns: many(tfRuns),
  approvals: many(approvals),
  iacJobs: many(iacJobs),
  organization: one(organizations, {
    fields: [workspaceDeployments.orgId],
    references: [organizations.id],
  }),
  runGroup: one(runGroups, {
    fields: [workspaceDeployments.runGroupId],
    references: [runGroups.id],
  }),
}))

export const runGroupsRelations = relations(runGroups, ({ one, many }) => ({
  tfRuns: many(tfRuns),
  workspaceDeployments: many(workspaceDeployments),
  organization: one(organizations, {
    fields: [runGroups.orgId],
    references: [organizations.id],
  }),
}))

export const approvalsRelations = relations(approvals, ({ one }) => ({
  workspaceDeployment: one(workspaceDeployments, {
    fields: [approvals.previewId],
    references: [workspaceDeployments.id],
  }),
  user: one(user, {
    fields: [approvals.userId],
    references: [user.id],
  }),
}))

export const jobsRelations = relations(jobs, ({ one }) => ({
  organization: one(organizations, {
    fields: [jobs.orgId],
    references: [organizations.id],
  }),
}))

export const repositoriesRelations = relations(repositories, ({ one }) => ({
  organization: one(organizations, {
    fields: [repositories.orgId],
    references: [organizations.id],
  }),
}))

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [workspaces.orgId],
    references: [organizations.id],
  }),
  stateVersions: many(stateVersions),
}))

export const stateVersionsRelations = relations(stateVersions, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [stateVersions.workspaceId],
    references: [workspaces.id],
  }),
  tfRun: one(tfRuns, {
    fields: [stateVersions.runId],
    references: [tfRuns.id],
  }),
}))

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(user, {
    fields: [apiTokens.userId],
    references: [user.id],
  }),
}))

export const iacJobsRelations = relations(iacJobs, ({ one }) => ({
  workspaceDeployment: one(workspaceDeployments, {
    fields: [iacJobs.previewId],
    references: [workspaceDeployments.id],
  }),
}))
