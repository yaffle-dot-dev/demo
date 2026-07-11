import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { uuidv7 } from "uuidv7"

// Re-export BetterAuth tables
export * from "./auth-schema"
import { user } from "./auth-schema"

// =============================================================================
// Enums
// =============================================================================

export const iacJobStatusEnum = pgEnum("iac_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "system_error",
  "cancelled",
])

export const iacJobTypeEnum = pgEnum("iac_job_type", ["plan", "apply", "destroy"])

// =============================================================================
// Organizations (decoupled from GitHub)
// =============================================================================

export const organizations = pgTable("organizations", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  stateBucket: text("state_bucket"), // Nullable until configured
  runnerMode: text("runner_mode").default("saas").notNull(), // 'saas' | 'byoa'
  membershipMode: text("membership_mode").default("github_self_join").notNull(), // 'github_self_join' | 'invite_only' | 'sso_only'
  // Security isolation fields (per-org KMS key and IAM role)
  kmsKeyArn: text("kms_key_arn"),
  kmsKeyAlias: text("kms_key_alias"),
  iamRoleArn: text("iam_role_arn"),
  provisioningStatus: text("provisioning_status").default("pending").notNull(), // 'pending' | 'provisioning' | 'active' | 'failed'
  provisioningError: text("provisioning_error"),
  provisioningAttempts: integer("provisioning_attempts").default(0).notNull(),
  // Billing (cached from Stripe via webhooks)
  stripeCustomerId: text("stripe_customer_id"),
  subscriptionStatus: text("subscription_status").default("none").notNull(), // 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid'
  planTier: text("plan_tier").default("free").notNull(), // 'free' | 'pro' | 'team'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// Private Beta Invites
// =============================================================================

export const betaAccessInvites = pgTable(
  "beta_access_invites",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    email: text("email").unique(),
    githubLogin: text("github_login").unique(),
    note: text("note"),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: "set null" }),
    claimedByUserId: text("claimed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("beta_access_invites_email_idx").on(t.email),
    index("beta_access_invites_github_login_idx").on(t.githubLogin),
    index("beta_access_invites_claimed_by_user_id_idx").on(t.claimedByUserId),
    index("beta_access_invites_revoked_at_idx").on(t.revokedAt),
  ],
)

// =============================================================================
// GitHub Installations (links Yaffle orgs to GitHub App installations)
// =============================================================================

export const githubInstallations = pgTable("github_installations", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  // orgId is nullable during migration — new installations created without an org
  githubOrgId: bigint("github_org_id", { mode: "number" }).notNull(),
  githubOrgLogin: text("github_org_login").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).unique().notNull(),
  installationStatus: text("installation_status").default("active").notNull(), // 'active' | 'suspended' | 'uninstalled'
  installedAt: timestamp("installed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// Org Memberships (links users to organizations with roles)
// =============================================================================

export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").notNull(), // 'viewer' | 'approver' | 'admin'
    source: text("source").notNull(), // 'github_self_join' | 'invite' | 'scim' | 'admin_bootstrap'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("org_memberships_org_user").on(t.orgId, t.userId)],
)

// =============================================================================
// Connections (for codegen mode - API keys for Grafana, etc.)
// =============================================================================

export const connections = pgTable("connections", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  orgId: uuid("org_id")
    .references(() => organizations.id)
    .notNull(),
  name: text("name").notNull(),
  providerType: text("provider_type"),
  credentialProviderType: text("credential_provider_type"),
  type: text("type").notNull(),
  config: jsonb("config").notNull(),
  secretStore: text("secret_store"),
  secretPath: text("secret_path"),
  secretArn: text("secret_arn").notNull(),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastValidationError: text("last_validation_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// Provider Credential Signatures (runtime-editable provider env var mapping)
// =============================================================================

export const providerCredentialSignatures = pgTable(
  "provider_credential_signatures",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    providerType: text("provider_type").notNull().unique(),
    displayName: text("display_name").notNull(),
    suggestedCredentialProviderType: text("suggested_credential_provider_type").notNull(),
    exactEnvVars: text("exact_env_vars").array().notNull().default([]),
    prefixEnvVars: text("prefix_env_vars").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    source: text("source").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("provider_credential_signatures_provider_type_idx").on(t.providerType),
    index("provider_credential_signatures_is_active_idx").on(t.isActive),
  ],
)

// =============================================================================
// Workspace Deployments (formerly "previews")
// =============================================================================

export const workspaceDeployments = pgTable(
  "workspace_deployments",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    runGroupId: uuid("run_group_id").references(() => runGroups.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }),
    repo: text("repo").notNull(),
    // Environment identification (new canonical discriminator)
    environmentKind: text("environment_kind").$type<"named" | "transient">().notNull(),
    environmentName: text("environment_name").notNull(), // 'main', 'staging', 'pr-123', etc.
    // PR number as metadata (nullable, not a discriminator)
    prNumber: integer("pr_number"), // GitHub PR number when that is the source; otherwise NULL
    workspacePath: text("workspace_path").notNull(),
    ref: text("ref").notNull(), // Full git ref: refs/heads/main, refs/tags/v1.0.0
    headSha: text("head_sha").notNull(),
    // GitHub user ID (stable) - used for matching to internal users via account table
    authorGithubId: bigint("author_github_id", { mode: "number" }),
    // GitHub username (display only) - can change if user renames their account
    authorLogin: text("author_login"),
    status: text("status").default("pending").notNull(),
    stateKey: text("state_key").notNull(),
    mode: text("mode").notNull(),
    requireApproval: boolean("require_approval").default(false).notNull(),
    approvers: jsonb("approvers"),
    // DAG coordination fields
    upstreamIds: text("upstream_ids").array().default([]).notNull(),
    completedUpstreams: text("completed_upstreams").array().default([]).notNull(),
    // Approval tracking
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // New unique constraint based on environment_name instead of pr_number
    unique("workspace_deployments_org_repo_env_workspace").on(
      t.orgId,
      t.repo,
      t.environmentName,
      t.workspacePath,
    ),
    check(
      "workspace_deployments_environment_kind_check",
      sql`${t.environmentKind} IN ('named', 'transient')`,
    ),
  ],
)

// Type alias for backward compatibility during migration
export const previews = workspaceDeployments

// =============================================================================
// Run Groups (groups related runs across workspaces)
// =============================================================================

export const runGroups = pgTable("run_groups", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  orgId: uuid("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
  repoBindingId: uuid("repo_binding_id").references(() => principalRepoBindings.id, {
    onDelete: "set null",
  }),
  repo: text("repo").notNull(),
  // Environment identification (new canonical discriminator)
  environmentKind: text("environment_kind").$type<"named" | "transient">().notNull(),
  environmentName: text("environment_name").notNull(), // 'main', 'staging', 'pr-123', etc.
  // PR number as metadata (nullable, not a discriminator)
  prNumber: integer("pr_number"), // GitHub PR number when that is the source; otherwise NULL
  ref: text("ref").notNull(), // Full git ref: refs/heads/main, refs/tags/v1.0.0
  headSha: text("head_sha").notNull(),
  selectedWorkspacePaths: jsonb("selected_workspace_paths")
    .default(sql`'[]'::jsonb`)
    .notNull(),
  checkRunId: bigint("check_run_id", { mode: "number" }),
  checkCompletedAt: timestamp("check_completed_at", { withTimezone: true }),
  trigger: text("trigger").notNull(), // 'pr_opened' | 'pr_sync' | 'push' | 'manual'
  triggeredByUserId: text("triggered_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  triggeredByLogin: text("triggered_by_login"),
  status: text("status").default("pending").notNull(), // 'pending' | 'running' | 'success' | 'failed' | 'partial'
  // Inferred dependency graph for this run group
  // Structure: { workspaces: string[], edges: [string, string][] }
  dependencyGraph: jsonb("dependency_graph"),
  // S3 key for cached workspace tarball: {org}/{repo}/{sha}/workspace.tar.gz
  // Uploaded during webhook processing, downloaded by runners
  workspaceS3Key: text("workspace_s3_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  check("run_groups_environment_kind_check", sql`${t.environmentKind} IN ('named', 'transient')`),
])

export const runGroupWorkspaceMetadata = pgTable(
  "run_group_workspace_metadata",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    runGroupId: uuid("run_group_id")
      .references(() => runGroups.id, { onDelete: "cascade" })
      .notNull(),
    workspacePath: text("workspace_path").notNull(),
    providerRequirements: jsonb("provider_requirements")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    extractionStatus: text("extraction_status").default("pending").notNull(),
    degradationKind: text("degradation_kind"),
    errorKind: text("error_kind"),
    errorMessage: text("error_message"),
    retryable: boolean("retryable").default(false).notNull(),
    source: text("source").default("scan_job").notNull(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("run_group_workspace_metadata_group_workspace").on(t.runGroupId, t.workspacePath),
    index("run_group_workspace_metadata_group_idx").on(t.runGroupId),
    index("run_group_workspace_metadata_status_idx").on(t.extractionStatus),
  ],
)

export const environmentGroupProjections = pgTable(
  "environment_group_projections",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    repo: text("repo").notNull(),
    environmentKind: text("environment_kind").notNull(),
    environmentName: text("environment_name").notNull(),
    sourceKind: text("source_kind"),
    sourceMetadata: jsonb("source_metadata"),
    status: text("status").notNull(),
    headSha: text("head_sha").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    workspaceCount: integer("workspace_count").default(0).notNull(),
    blockedWorkspaceCount: integer("blocked_workspace_count").default(0).notNull(),
    degradedWorkspaceCount: integer("degraded_workspace_count").default(0).notNull(),
    version: integer("version").default(1).notNull(),
    payload: jsonb("payload").notNull(),
    rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).notNull(),
    rebuildError: text("rebuild_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    rowUpdatedAt: timestamp("row_updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("environment_group_projections_org_repo_kind_name").on(
      t.orgId,
      t.repo,
      t.environmentKind,
      t.environmentName,
    ),
    index("environment_group_projections_org_kind_idx").on(t.orgId, t.environmentKind),
    index("environment_group_projections_org_repo_idx").on(t.orgId, t.repo),
  ],
)

// =============================================================================
// Scan Jobs (dependency scanning worker jobs)
// =============================================================================

export const scanJobStatusEnum = pgEnum("scan_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
])

export const scanJobs = pgTable(
  "scan_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    runGroupId: uuid("run_group_id")
      .references(() => runGroups.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    status: scanJobStatusEnum("status").default("queued").notNull(),
    workerId: text("worker_id"),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
    // Inputs
    repoUrl: text("repo_url").notNull(),
    ref: text("ref").notNull(),
    headSha: text("head_sha").notNull(),
    installationToken: text("installation_token"),
    orgSlug: text("org_slug").notNull(),
    // Workspace paths to scan (from parsed yaffle.toml)
    workspacePaths: jsonb("workspace_paths"),
    // Effective workspace variables to bind during dependency scanning
    workspaceVariables: jsonb("workspace_variables"),
    // Opted-in transient workspaces requiring automatic isolation preflight
    automaticIsolationWorkspacePaths: jsonb("automatic_isolation_workspace_paths")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    // Result
    result: jsonb("result"),
    errorMessage: text("error_message"),
    // Timing
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("scan_jobs_status_idx").on(table.status),
    index("scan_jobs_run_group_id_idx").on(table.runGroupId),
  ],
)

// =============================================================================
// TF Runs
// =============================================================================

export const tfRuns = pgTable(
  "tf_runs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    deploymentId: uuid("deployment_id")
      .references(() => workspaceDeployments.id)
      .notNull(),
    runGroupId: uuid("run_group_id").references(() => runGroups.id, { onDelete: "set null" }),
    runType: text("run_type").notNull(),
    status: text("status").notNull(),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    ecsTaskArn: text("ecs_task_arn"),
    planSummary: text("plan_summary"),
    planJson: jsonb("plan_json"),
    planFileS3Key: text("plan_file_s3_key"),
    logOutput: text("log_output"),
    outputs: jsonb("outputs"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tf_runs_deployment_id_idx").on(t.deploymentId, t.createdAt.desc())],
)

// =============================================================================
// Resource Spans (resource-level timing from tofu runs)
// =============================================================================

export const resourceSpans = pgTable(
  "resource_spans",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    runId: uuid("run_id")
      .references(() => tfRuns.id, { onDelete: "cascade" })
      .notNull(),
    resourceAddress: text("resource_address").notNull(),
    resourceType: text("resource_type"),
    action: text("action").notNull(), // create | update | delete | refresh | read
    status: text("status").default("started").notNull(), // started | complete | error
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    source: text("source").default("log_parse").notNull(), // log_parse | otlp (future)
    traceId: text("trace_id"),
    spanId: text("span_id"),
    parentSpanId: text("parent_span_id"),
    attributes: jsonb("attributes").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("resource_spans_run_id_idx").on(t.runId)],
)

// =============================================================================
// Approvals (now uses BetterAuth user ID)
// =============================================================================

export const approvals = pgTable("approvals", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  deploymentId: uuid("deployment_id")
    .references(() => workspaceDeployments.id)
    .notNull(),
  userId: text("user_id")
    .references(() => user.id)
    .notNull(),
  approverLogin: text("approver_login"), // Denormalized for display
  approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// Jobs (generic background job queue)
// =============================================================================

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").default("pending").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    lockedBy: text("locked_by"),
    attempts: integer("attempts").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Optimizes ordered claims of the oldest runnable pending job without
    // bloating the index with terminal rows.
    index("jobs_pending_claim_idx")
      .on(t.runAt.asc(), t.createdAt.asc(), t.id.asc())
      .where(sql`${t.status} = 'pending' and ${t.lockedBy} is null`),
  ],
)

// =============================================================================
// IaC Jobs (terraform plan/apply/destroy execution queue)
// =============================================================================

function buildIacJobColumns() {
  return {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    deploymentId: uuid("deployment_id")
      .references(() => workspaceDeployments.id, { onDelete: "cascade" })
      .notNull(),
    jobType: iacJobTypeEnum("job_type").notNull(),
    status: iacJobStatusEnum("status").default("queued").notNull(),
    // Worker tracking
    workerId: text("worker_id"),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
    spawnLeaseToken: text("spawn_lease_token"),
    spawnLeaseHolder: text("spawn_lease_holder"),
    spawnLeaseExpiresAt: timestamp("spawn_lease_expires_at", { withTimezone: true }),
    // Timing
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    lastSpawnAttemptAt: timestamp("last_spawn_attempt_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Result
    result: jsonb("result"), // Output, plan summary, errors, etc.
    blockedReason: text("blocked_reason"),
    errorMessage: text("error_message"),
    // Retry tracking
    attempts: integer("attempts").default(0).notNull(),
    spawnAttempts: integer("spawn_attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
  }
}

export const iacJobs = pgTable("iac_jobs", buildIacJobColumns(), (t) => [
  // Index for efficient job queue claiming:
  // - Filters on status='queued'
  // - Orders by job_type (priority) then queued_at
  index("iac_jobs_queue_priority_idx").on(t.status, t.jobType, t.queuedAt),
  index("iac_jobs_spawn_lease_idx").on(t.status, t.spawnLeaseExpiresAt),
  index("iac_jobs_deployment_queued_at_idx").on(t.deploymentId.asc(), t.queuedAt.desc()),
])

export const iacJobHistory = pgTable("iac_job_history", buildIacJobColumns(), (t) => [
  index("iac_job_history_deployment_queued_at_idx").on(t.deploymentId.asc(), t.queuedAt.desc()),
  index("iac_job_history_deployment_type_queued_at_idx").on(
    t.deploymentId.asc(),
    t.jobType.asc(),
    t.queuedAt.desc(),
  ),
  index("iac_job_history_completed_at_idx").on(t.completedAt.desc()),
])

// =============================================================================
// Repositories
// =============================================================================

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id").references(() => organizations.id),
    // orgId is nullable during migration — repos are now installation inventory
    installationId: bigint("installation_id", { mode: "number" }),
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").default("main").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("repositories_github_id").on(t.githubId)],
)

// =============================================================================
// GitHub Repo Mappings (explicit binding from GitHub repo to Yaffle org)
// =============================================================================

export const githubRepoMappings = pgTable(
  "github_repo_mappings",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("github_repo_mappings_install_repo").on(t.installationId, t.githubRepoId),
    index("github_repo_mappings_org_id_idx").on(t.orgId),
  ],
)

// =============================================================================
// TFC State Backend: Workspaces
// =============================================================================

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    repo: text("repo").notNull(),
    workspacePath: text("workspace_path").notNull(),
    environmentKind: text("environment_kind").$type<"named" | "transient">().notNull(),
    environmentName: text("environment_name").notNull(),
    ref: text("ref").notNull(), // Full git ref: refs/heads/main, refs/tags/v1.0.0
    locked: boolean("locked").default(false).notNull(),
    lockedBy: text("locked_by"), // "user:{id}" or "run:{id}"
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockReason: text("lock_reason"),
    lockId: text("lock_id"), // "{org_slug}/{workspace_name}" for force-unlock
    currentStateVersionId: uuid("current_state_version_id"), // FK added below
    terraformVersion: text("terraform_version"),
    status: text("status").default("active").notNull(), // "active" | "destroying" | "archived"
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("workspaces_org_name").on(t.orgId, t.name),
    unique("workspaces_environment_identity_unique").on(
      t.orgId,
      t.repo,
      t.workspacePath,
      t.environmentKind,
      t.environmentName,
    ),
    check("workspaces_environment_kind_check", sql`${t.environmentKind} IN ('named', 'transient')`),
    check("workspaces_environment_name_check", sql`length(btrim(${t.environmentName})) > 0`),
  ],
)

// =============================================================================
// TFC State Backend: State Versions
// =============================================================================

export const stateVersions = pgTable("state_versions", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  serial: integer("serial").notNull(),
  lineage: uuid("lineage"),
  md5: text("md5").notNull(),
  size: integer("size").notNull(),
  s3Key: text("s3_key").notNull(),
  status: text("status").default("pending").notNull(), // "pending" | "finalized" | "discarded"
  terraformVersion: text("terraform_version"),
  resources: jsonb("resources"),
  outputs: jsonb("outputs"),
  resourcesProcessed: boolean("resources_processed").default(false).notNull(),
  runId: uuid("run_id").references(() => tfRuns.id),
  createdBy: text("created_by"), // user_id or "run:{id}"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// TFC State Backend: API Tokens (for terraform login)
// =============================================================================

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  userId: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  description: text("description"),
  scopes: text("scopes")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  createdByFlow: text("created_by_flow"),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// Local-First Principals and Hosted Output Modules
// =============================================================================

export const principals = pgTable(
  "principals",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    type: text("type").notNull(), // 'account' | 'anonymous_session'
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    status: text("status").default("active").notNull(), // 'active' | 'expired' | 'revoked'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("principals_user_id_unique").on(t.userId)],
)

export const anonymousSessions = pgTable(
  "anonymous_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    principalId: uuid("principal_id")
      .references(() => principals.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status").default("active").notNull(), // 'active' | 'expired' | 'revoked'
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("anonymous_sessions_principal_idx").on(t.principalId)],
)

export const principalRepoBindings = pgTable(
  "principal_repo_bindings",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    principalId: uuid("principal_id")
      .references(() => principals.id, { onDelete: "cascade" })
      .notNull(),
    canonicalRepoNamespace: text("canonical_repo_namespace").notNull(),
    localRepoFingerprint: text("local_repo_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("principal_repo_bindings_unique").on(
      t.principalId,
      t.canonicalRepoNamespace,
      t.localRepoFingerprint,
    ),
    index("principal_repo_bindings_principal_idx").on(t.principalId),
  ],
)

export const hostedOutputModules = pgTable(
  "hosted_output_modules",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    principalId: uuid("principal_id").references(() => principals.id, { onDelete: "cascade" }),
    repoBindingId: uuid("repo_binding_id").references(() => principalRepoBindings.id, {
      onDelete: "cascade",
    }),
    canonicalRepoNamespace: text("canonical_repo_namespace").notNull(),
    environmentName: text("environment_name").notNull(),
    workspacePath: text("workspace_path").notNull(),
    versionSerial: integer("version_serial").notNull(),
    stateFingerprint: text("state_fingerprint").notNull(),
    outputs: jsonb("outputs").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("hosted_output_modules_scope_version_unique").on(
      t.canonicalRepoNamespace,
      t.environmentName,
      t.workspacePath,
      t.versionSerial,
    ),
    index("hosted_output_modules_scope_idx").on(
      t.canonicalRepoNamespace,
      t.environmentName,
      t.workspacePath,
    ),
  ],
)

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    orgSlug: text("org_slug").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("oauth_authorization_codes_expires_at_idx").on(t.expiresAt)],
)

export const cloudCliAuthorizationCodes = pgTable(
  "cloud_cli_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: text("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("cloud_cli_authorization_codes_expires_at_idx").on(t.expiresAt)],
)

export const lifecycleRuns = pgTable(
  "lifecycle_runs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    principalId: uuid("principal_id")
      .references(() => principals.id, { onDelete: "cascade" })
      .notNull(),
    runGroupId: uuid("run_group_id").references(() => runGroups.id, { onDelete: "set null" }),
    repoBindingId: uuid("repo_binding_id")
      .references(() => principalRepoBindings.id, { onDelete: "cascade" })
      .notNull(),
    environmentName: text("environment_name").notNull(),
    executionMode: text("execution_mode").notNull(), // 'local' | 'cloud'
    status: text("status").default("running").notNull(), // 'running' | 'succeeded' | 'degraded' | 'failed'
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("lifecycle_runs_repo_env_idx").on(t.repoBindingId, t.environmentName, t.createdAt),
    index("lifecycle_runs_principal_idx").on(t.principalId, t.createdAt),
    index("lifecycle_runs_run_group_idx").on(t.runGroupId),
  ],
)

export const lifecycleItems = pgTable(
  "lifecycle_items",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    runId: uuid("run_id")
      .references(() => lifecycleRuns.id, { onDelete: "cascade" })
      .notNull(),
    workspacePath: text("workspace_path").notNull(),
    key: text("key").notNull(),
    phase: text("phase").notNull(), // 'activation' | 'verification'
    kind: text("kind").notNull(), // 'webhook'
    state: text("state").default("pending").notNull(), // 'pending' | 'running' | 'succeeded' | 'degraded' | 'blocked' | 'failed'
    failurePolicy: text("failure_policy").notNull(), // 'failed' | 'degraded'
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    destinationUrl: text("destination_url").notNull(),
    destinationClass: text("destination_class").notNull(), // 'public' | 'private_local'
    dispatchMode: text("dispatch_mode").notNull(), // 'local' | 'cloud'
    summary: text("summary"),
    reason: text("reason"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("lifecycle_items_run_workspace_phase_key_unique").on(
      t.runId,
      t.workspacePath,
      t.phase,
      t.key,
    ),
    index("lifecycle_items_run_idx").on(t.runId, t.phase, t.workspacePath),
  ],
)

export const lifecycleEvents = pgTable(
  "lifecycle_events",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    itemId: uuid("item_id")
      .references(() => lifecycleItems.id, { onDelete: "cascade" })
      .notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("lifecycle_events_item_idx").on(t.itemId, t.createdAt)],
)

export const lifecycleCompletionTokens = pgTable(
  "lifecycle_completion_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    itemId: uuid("item_id")
      .references(() => lifecycleItems.id, { onDelete: "cascade" })
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("lifecycle_completion_tokens_expires_idx").on(t.expiresAt)],
)

export const environmentPolicies = pgTable(
  "environment_policies",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    repoFullName: text("repo_full_name").notNull(),
    environmentName: text("environment_name").notNull(),
    minimumPrincipalTier: text("minimum_principal_tier").notNull(), // 'anonymous' | 'free_local' | 'paid_cloud'
    lifecycleDispatch: text("lifecycle_dispatch").notNull(), // 'auto' | 'central'
    allowedDestinationClasses: text("allowed_destination_classes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("environment_policies_org_repo_env_unique").on(
      t.orgId,
      t.repoFullName,
      t.environmentName,
    ),
    index("environment_policies_repo_env_idx").on(t.repoFullName, t.environmentName),
  ],
)

// =============================================================================
// Distributed Leases
// =============================================================================

export const leases = pgTable("leases", {
  key: text("key").primaryKey(),
  holderId: text("holder_id").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).defaultNow().notNull(),
  renewedAt: timestamp("renewed_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
})

// =============================================================================
// Warm Runner Sessions
// =============================================================================

export const warmRunnerSessions = pgTable(
  "warm_runner_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    workerId: text("worker_id").notNull(),
    status: text("status").default("active").notNull(), // 'active' | 'draining' | 'stopped'
    maxSlots: integer("max_slots").default(1).notNull(),
    activeSlots: integer("active_slots").default(0).notNull(),
    metadata: jsonb("metadata"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    lastIdleAt: timestamp("last_idle_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("warm_runner_sessions_worker_id").on(t.workerId),
    index("warm_runner_sessions_org_status_idx").on(t.orgId, t.status, t.lastHeartbeatAt),
  ],
)
