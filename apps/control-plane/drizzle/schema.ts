import { pgTable, text, timestamp, unique, boolean, foreignKey, uuid, integer, index, bigint, jsonb } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const verification = pgTable("verification", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
});

export const user = pgTable("user", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("user_email_unique").on(table.email),
]);

export const account = pgTable("account", {
	id: text().primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const session = pgTable("session", {
	id: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	token: text().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("session_token_unique").on(table.token),
]);

export const organizations = pgTable("organizations", {
	id: uuid().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	stateBucket: text("state_bucket"),
	runnerMode: text("runner_mode").default('saas').notNull(),
	membershipMode: text("membership_mode").default('github_self_join').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	kmsKeyArn: text("kms_key_arn"),
	kmsKeyAlias: text("kms_key_alias"),
	iamRoleArn: text("iam_role_arn"),
	provisioningStatus: text("provisioning_status").default('pending').notNull(),
	provisioningError: text("provisioning_error"),
	provisioningAttempts: integer("provisioning_attempts").default(0).notNull(),
}, (table) => [
	unique("organizations_slug_unique").on(table.slug),
]);

export const apikey = pgTable("apikey", {
	id: text().primaryKey().notNull(),
	configId: text("config_id").default('default').notNull(),
	name: text(),
	start: text(),
	referenceId: text("reference_id").notNull(),
	prefix: text(),
	key: text().notNull(),
	refillInterval: integer("refill_interval"),
	refillAmount: integer("refill_amount"),
	lastRefillAt: timestamp("last_refill_at", { mode: 'string' }),
	enabled: boolean().default(true),
	rateLimitEnabled: boolean("rate_limit_enabled").default(true),
	rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
	rateLimitMax: integer("rate_limit_max").default(10),
	requestCount: integer("request_count").default(0),
	remaining: integer(),
	lastRequest: timestamp("last_request", { mode: 'string' }),
	expiresAt: timestamp("expires_at", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
	permissions: text(),
	metadata: text(),
}, (table) => [
	index("apikey_configId_idx").using("btree", table.configId.asc().nullsLast().op("text_ops")),
	index("apikey_key_idx").using("btree", table.key.asc().nullsLast().op("text_ops")),
	index("apikey_referenceId_idx").using("btree", table.referenceId.asc().nullsLast().op("text_ops")),
]);

export const githubInstallations = pgTable("github_installations", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubOrgId: bigint("github_org_id", { mode: "number" }).notNull(),
	githubOrgLogin: text("github_org_login").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	installationId: bigint("installation_id", { mode: "number" }).notNull(),
	installationStatus: text("installation_status").default('active').notNull(),
	installedAt: timestamp("installed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "github_installations_org_id_organizations_id_fk"
		}).onDelete("cascade"),
	unique("github_installations_installation_id_unique").on(table.installationId),
]);

export const orgMemberships = pgTable("org_memberships", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	userId: text("user_id").notNull(),
	role: text().notNull(),
	source: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "org_memberships_org_id_organizations_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "org_memberships_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("org_memberships_org_user").on(table.orgId, table.userId),
]);

export const connections = pgTable("connections", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	name: text().notNull(),
	type: text().notNull(),
	config: jsonb().notNull(),
	secretArn: text("secret_arn").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "connections_org_id_organizations_id_fk"
		}),
]);

export const tfRuns = pgTable("tf_runs", {
	id: uuid().primaryKey().notNull(),
	previewId: uuid("preview_id").notNull(),
	runGroupId: uuid("run_group_id"),
	runType: text("run_type").notNull(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	checkRunId: bigint("check_run_id", { mode: "number" }),
	ecsTaskArn: text("ecs_task_arn"),
	planSummary: text("plan_summary"),
	planJson: jsonb("plan_json"),
	logOutput: text("log_output"),
	outputs: jsonb(),
	errorMessage: text("error_message"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.previewId],
			foreignColumns: [workspaceDeployments.id],
			name: "tf_runs_preview_id_previews_id_fk"
		}),
	foreignKey({
			columns: [table.runGroupId],
			foreignColumns: [runGroups.id],
			name: "tf_runs_run_group_id_run_groups_id_fk"
		}).onDelete("set null"),
]);

export const approvals = pgTable("approvals", {
	id: uuid().primaryKey().notNull(),
	previewId: uuid("preview_id").notNull(),
	userId: text("user_id").notNull(),
	approverLogin: text("approver_login"),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.previewId],
			foreignColumns: [workspaceDeployments.id],
			name: "approvals_preview_id_previews_id_fk"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "approvals_user_id_user_id_fk"
		}),
]);

export const jobs = pgTable("jobs", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	jobType: text("job_type").notNull(),
	payload: jsonb().notNull(),
	status: text().default('pending').notNull(),
	runAt: timestamp("run_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lockedBy: text("locked_by"),
	attempts: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "jobs_org_id_organizations_id_fk"
		}),
]);

export const repositories = pgTable("repositories", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubId: bigint("github_id", { mode: "number" }).notNull(),
	name: text().notNull(),
	fullName: text("full_name").notNull(),
	defaultBranch: text("default_branch").default('main').notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "repositories_org_id_organizations_id_fk"
		}),
	unique("repositories_github_id").on(table.githubId),
]);

export const workspaces = pgTable("workspaces", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	name: text().notNull(),
	repo: text().notNull(),
	workspacePath: text("workspace_path").notNull(),
	environment: text().notNull(),
	prNumber: integer("pr_number"),
	ref: text().notNull(),
	locked: boolean().default(false).notNull(),
	lockedBy: text("locked_by"),
	lockedAt: timestamp("locked_at", { withTimezone: true, mode: 'string' }),
	lockReason: text("lock_reason"),
	lockId: text("lock_id"),
	currentStateVersionId: uuid("current_state_version_id"),
	terraformVersion: text("terraform_version"),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "workspaces_org_id_organizations_id_fk"
		}).onDelete("cascade"),
	unique("workspaces_org_name").on(table.orgId, table.name),
]);

export const stateVersions = pgTable("state_versions", {
	id: uuid().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	serial: integer().notNull(),
	lineage: uuid(),
	md5: text().notNull(),
	size: integer().notNull(),
	s3Key: text("s3_key").notNull(),
	status: text().default('pending').notNull(),
	terraformVersion: text("terraform_version"),
	resources: jsonb(),
	outputs: jsonb(),
	resourcesProcessed: boolean("resources_processed").default(false).notNull(),
	runId: uuid("run_id"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workspaceId],
			foreignColumns: [workspaces.id],
			name: "state_versions_workspace_id_workspaces_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [tfRuns.id],
			name: "state_versions_run_id_tf_runs_id_fk"
		}),
]);

export const apiTokens = pgTable("api_tokens", {
	id: uuid().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	description: text(),
	tokenHash: text("token_hash").notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "api_tokens_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const iacJobs = pgTable("iac_jobs", {
	id: uuid().primaryKey().notNull(),
	previewId: uuid("preview_id").notNull(),
	jobType: text("job_type").notNull(),
	status: text().default('queued').notNull(),
	workerId: text("worker_id"),
	lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true, mode: 'string' }),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	result: jsonb(),
	errorMessage: text("error_message"),
	attempts: integer().default(0).notNull(),
	maxAttempts: integer("max_attempts").default(3).notNull(),
}, (table) => [
	index("iac_jobs_queue_priority_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.jobType.asc().nullsLast().op("text_ops"), table.queuedAt.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.previewId],
			foreignColumns: [workspaceDeployments.id],
			name: "iac_jobs_preview_id_previews_id_fk"
		}).onDelete("cascade"),
]);

export const workspaceDeployments = pgTable("workspace_deployments", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	installationId: bigint("installation_id", { mode: "number" }),
	repo: text().notNull(),
	prNumber: integer("pr_number"),
	workspacePath: text("workspace_path").notNull(),
	ref: text().notNull(),
	headSha: text("head_sha").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authorGithubId: bigint("author_github_id", { mode: "number" }),
	authorLogin: text("author_login"),
	status: text().default('pending').notNull(),
	stateKey: text("state_key").notNull(),
	mode: text().notNull(),
	requireApproval: boolean("require_approval").default(false).notNull(),
	approvers: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	runGroupId: uuid("run_group_id"),
	upstreamIds: text("upstream_ids").array().default([""]).notNull(),
	completedUpstreams: text("completed_upstreams").array().default([""]).notNull(),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	approvedBy: text("approved_by"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	environmentKind: text("environment_kind").notNull(),
	environmentName: text("environment_name").notNull(),
	statusChangedAt: timestamp("status_changed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("workspace_deployments_upstream_ids_gin").using("gin", table.upstreamIds.asc().nullsLast().op("array_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "previews_org_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.runGroupId],
			foreignColumns: [runGroups.id],
			name: "previews_run_group_id_run_groups_id_fk"
		}).onDelete("cascade"),
	unique("workspace_deployments_org_repo_env_workspace").on(table.orgId, table.repo, table.workspacePath, table.environmentName),
]);

export const runGroups = pgTable("run_groups", {
	id: uuid().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	repo: text().notNull(),
	prNumber: integer("pr_number"),
	ref: text().notNull(),
	headSha: text("head_sha").notNull(),
	trigger: text().notNull(),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	dependencyGraph: jsonb("dependency_graph"),
	environmentKind: text("environment_kind").notNull(),
	environmentName: text("environment_name").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "run_groups_org_id_organizations_id_fk"
		}).onDelete("cascade"),
]);
