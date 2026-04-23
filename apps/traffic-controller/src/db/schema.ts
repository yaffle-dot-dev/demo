import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { uuidv7 } from "uuidv7"

export const trafficControl = pgSchema("traffic_control")

export const routeableDeploymentStateEnum = trafficControl.enum("routeable_deployment_state", [
  "active",
  "inactive",
  "destroyed",
])

export const routeableDeploymentReceiverKindEnum = trafficControl.enum("routeable_deployment_receiver_kind", [
  "github_webhook",
])

export const liveWebhookLeaseStatusEnum = trafficControl.enum("live_webhook_lease_status", [
  "requested",
  "active",
  "revoking",
  "revoked",
  "rejected",
  "error",
])

export const liveWebhookScopeClassEnum = trafficControl.enum("live_webhook_scope_class", [
  "repo",
  "installation",
])

export const liveWebhookEventEnum = trafficControl.enum("live_webhook_event", [
  "pull_request",
  "push",
  "installation_repositories",
])

export const trafficControlOperationTypeEnum = trafficControl.enum("operation_type", [
  "ensure_routeable_deployment",
  "ensure_live_webhook_lease",
  "revoke_live_webhook_lease",
  "reconcile_live_webhook_lease",
  "sweep_drift",
])

export const trafficControlOperationStatusEnum = trafficControl.enum("operation_status", [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "rejected",
])

export const routeableDeployments = trafficControl.table("routeable_deployments", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  externalDeploymentId: text("external_deployment_id").notNull(),
  prNumber: integer("pr_number").notNull(),
  environmentName: text("environment_name").notNull(),
  environmentKind: text("environment_kind").notNull(),
  ownerGithubUserId: bigint("owner_github_user_id", { mode: "number" }).notNull(),
  ownerGithubLoginSnapshot: text("owner_github_login_snapshot").notNull(),
  receiverUrl: text("receiver_url").notNull(),
  receiverKind: routeableDeploymentReceiverKindEnum("receiver_kind").default("github_webhook").notNull(),
  state: routeableDeploymentStateEnum("state").default("inactive").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("tc_routeable_deployments_external_deployment_id_idx").on(t.externalDeploymentId),
  index("tc_routeable_deployments_pr_number_idx").on(t.prNumber),
  index("tc_routeable_deployments_owner_github_user_id_idx").on(t.ownerGithubUserId),
  index("tc_routeable_deployments_state_idx").on(t.state),
])

export const liveWebhookLeases = trafficControl.table("live_webhook_leases", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  status: liveWebhookLeaseStatusEnum("status").default("requested").notNull(),
  prNumber: integer("pr_number").notNull(),
  routeableDeploymentId: uuid("routeable_deployment_id")
    .references(() => routeableDeployments.id, { onDelete: "cascade" })
    .notNull(),
  actorGithubUserId: bigint("actor_github_user_id", { mode: "number" }).notNull(),
  actorGithubLoginSnapshot: text("actor_github_login_snapshot").notNull(),
  scopeClass: liveWebhookScopeClassEnum("scope_class").notNull(),
  event: liveWebhookEventEnum("event").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  repositoryId: bigint("repository_id", { mode: "number" }),
  action: text("action"),
  pullRequestNumber: integer("pull_request_number"),
  ref: text("ref"),
  githubOwnerTypeSnapshot: text("github_owner_type_snapshot").notNull(),
  githubOwnerIdSnapshot: bigint("github_owner_id_snapshot", { mode: "number" }).notNull(),
  githubOwnerLoginSnapshot: text("github_owner_login_snapshot").notNull(),
  reason: text("reason").notNull(),
  hookdeckDestinationId: text("hookdeck_destination_id"),
  hookdeckDestinationName: text("hookdeck_destination_name"),
  hookdeckConnectionId: text("hookdeck_connection_id"),
  hookdeckConnectionName: text("hookdeck_connection_name"),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  check(
    "tc_live_webhook_leases_scope_consistency",
    sql`((${t.scopeClass} = 'repo' and ${t.repositoryId} is not null) or (${t.scopeClass} = 'installation' and ${t.repositoryId} is null))`,
  ),
  index("tc_live_webhook_leases_pr_number_idx").on(t.prNumber),
  index("tc_live_webhook_leases_routeable_deployment_id_idx").on(t.routeableDeploymentId),
  index("tc_live_webhook_leases_status_idx").on(t.status),
  index("tc_live_webhook_leases_scope_lookup_idx").on(
    t.status,
    t.event,
    t.installationId,
    t.repositoryId,
  ),
])

export const trafficControlOperations = trafficControl.table("operations", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  requestId: text("request_id").notNull(),
  operationType: trafficControlOperationTypeEnum("operation_type").notNull(),
  status: trafficControlOperationStatusEnum("status").default("accepted").notNull(),
  routeableDeploymentId: uuid("routeable_deployment_id")
    .references(() => routeableDeployments.id, { onDelete: "cascade" }),
  liveWebhookLeaseId: uuid("live_webhook_lease_id")
    .references(() => liveWebhookLeases.id, { onDelete: "cascade" }),
  actorGithubUserId: bigint("actor_github_user_id", { mode: "number" }),
  actorGithubLoginSnapshot: text("actor_github_login_snapshot"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  resultCode: text("result_code"),
  resultMessage: text("result_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("tc_operations_request_id_idx").on(t.requestId),
  index("tc_operations_status_idx").on(t.status),
  index("tc_operations_operation_type_idx").on(t.operationType),
  index("tc_operations_live_webhook_lease_id_idx").on(t.liveWebhookLeaseId),
])

export const trafficControlAuditEvents = trafficControl.table("audit_events", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  operationId: uuid("operation_id")
    .references(() => trafficControlOperations.id, { onDelete: "set null" }),
  routeableDeploymentId: uuid("routeable_deployment_id")
    .references(() => routeableDeployments.id, { onDelete: "set null" }),
  liveWebhookLeaseId: uuid("live_webhook_lease_id")
    .references(() => liveWebhookLeases.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  actorGithubUserId: bigint("actor_github_user_id", { mode: "number" }),
  actorGithubLoginSnapshot: text("actor_github_login_snapshot"),
  details: jsonb("details").default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("tc_audit_events_event_type_idx").on(t.eventType),
  index("tc_audit_events_live_webhook_lease_id_idx").on(t.liveWebhookLeaseId),
  index("tc_audit_events_created_at_idx").on(t.createdAt),
])
