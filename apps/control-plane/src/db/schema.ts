import {
  bigint,
  boolean,
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

export const iacJobTypeEnum = pgEnum("iac_job_type", [
  "plan",
  "apply",
  "destroy",
])

// =============================================================================
// Organizations (decoupled from GitHub)
// =============================================================================

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// GitHub Installations (links Yaffle orgs to GitHub App installations)
// =============================================================================

export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
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
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
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
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
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

export const providerCredentialSignatures = pgTable("provider_credential_signatures", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  providerType: text("provider_type").notNull().unique(),
  displayName: text("display_name").notNull(),
  suggestedCredentialProviderType: text("suggested_credential_provider_type").notNull(),
  exactEnvVars: text("exact_env_vars").array().notNull().default([]),
  prefixEnvVars: text("prefix_env_vars").array().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  source: text("source").notNull().default("system"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("provider_credential_signatures_provider_type_idx").on(t.providerType),
  index("provider_credential_signatures_is_active_idx").on(t.isActive),
])

// =============================================================================
// Workspace Deployments (formerly "previews")
// =============================================================================

export const workspaceDeployments = pgTable(
  "workspace_deployments",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    runGroupId: uuid("run_group_id")
      .references(() => runGroups.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }),
    repo: text("repo").notNull(),
    // Environment identification (new canonical discriminator)
    environmentKind: text("environment_kind").notNull(), // 'named' | 'transient'
    environmentName: text("environment_name").notNull(), // 'main', 'staging', 'pr-123', etc.
    // PR number as metadata (nullable, not a discriminator)
    prNumber: integer("pr_number"), // NULL for named environments, PR number for transient
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
  ],
)

// Type alias for backward compatibility during migration
export const previews = workspaceDeployments

// =============================================================================
// Run Groups (groups related runs across workspaces)
// =============================================================================

export const runGroups = pgTable("run_groups", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
  repo: text("repo").notNull(),
  // Environment identification (new canonical discriminator)
  environmentKind: text("environment_kind").notNull(), // 'named' | 'transient'
  environmentName: text("environment_name").notNull(), // 'main', 'staging', 'pr-123', etc.
  // PR number as metadata (nullable, not a discriminator)
  prNumber: integer("pr_number"), // NULL for named environments, PR number for transient
  ref: text("ref").notNull(), // Full git ref: refs/heads/main, refs/tags/v1.0.0
  headSha: text("head_sha").notNull(),
  trigger: text("trigger").notNull(), // 'pr_opened' | 'pr_sync' | 'push' | 'manual'
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
})

// =============================================================================
// TF Runs
// =============================================================================

export const tfRuns = pgTable("tf_runs", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  // Note: Column still named preview_id in DB for FK compatibility during migration
  // Will be renamed to deployment_id in a future migration
  deploymentId: uuid("preview_id")
    .references(() => workspaceDeployments.id)
    .notNull(),
  runGroupId: uuid("run_group_id")
    .references(() => runGroups.id, { onDelete: "set null" }),
  runType: text("run_type").notNull(),
  status: text("status").notNull(),
  checkRunId: bigint("check_run_id", { mode: "number" }),
  ecsTaskArn: text("ecs_task_arn"),
  planSummary: text("plan_summary"),
  planJson: jsonb("plan_json"),
  logOutput: text("log_output"),
  outputs: jsonb("outputs"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})

// =============================================================================
// Approvals (now uses BetterAuth user ID)
// =============================================================================

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  // Note: Column still named preview_id in DB for FK compatibility during migration
  deploymentId: uuid("preview_id")
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

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
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
})

// =============================================================================
// IaC Jobs (terraform plan/apply/destroy execution queue)
// =============================================================================

export const iacJobs = pgTable(
  "iac_jobs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    // Note: Column still named preview_id in DB for FK compatibility during migration
    deploymentId: uuid("preview_id")
      .references(() => workspaceDeployments.id, { onDelete: "cascade" })
      .notNull(),
    jobType: iacJobTypeEnum("job_type").notNull(),
    status: iacJobStatusEnum("status").default("queued").notNull(),
    // Worker tracking
    workerId: text("worker_id"),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
    // Timing
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Result
    result: jsonb("result"), // Output, plan summary, errors, etc.
    blockedReason: text("blocked_reason"),
    errorMessage: text("error_message"),
    // Retry tracking
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
  },
  (t) => [
    // Index for efficient job queue claiming:
    // - Filters on status='queued'
    // - Orders by job_type (priority) then queued_at
    index("iac_jobs_queue_priority_idx").on(t.status, t.jobType, t.queuedAt),
  ],
)

// =============================================================================
// Repositories
// =============================================================================

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
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
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
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
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    repo: text("repo").notNull(),
    workspacePath: text("workspace_path").notNull(),
    environment: text("environment").notNull(), // "preview" or environment name (e.g. "main")
    prNumber: integer("pr_number"),
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
  (t) => [unique("workspaces_org_name").on(t.orgId, t.name)],
)

// =============================================================================
// TFC State Backend: State Versions
// =============================================================================

export const stateVersions = pgTable("state_versions", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
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
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  userId: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .notNull(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  description: text("description"),
  scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
  createdByFlow: text("created_by_flow"),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
})
