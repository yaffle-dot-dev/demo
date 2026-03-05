import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { uuidv7 } from "uuidv7"

// Re-export BetterAuth tables
export * from "./auth-schema"
import { user } from "./auth-schema"

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
  installedAt: timestamp("installed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
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
  type: text("type").notNull(),
  config: jsonb("config").notNull(),
  secretArn: text("secret_arn").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

// =============================================================================
// Previews
// =============================================================================

export const previews = pgTable(
  "previews",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    installationId: bigint("installation_id", { mode: "number" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    workspacePath: text("workspace_path").notNull(),
    branch: text("branch").notNull(),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("previews_org_repo_pr_workspace").on(t.orgId, t.repo, t.prNumber, t.workspacePath),
  ],
)

// =============================================================================
// TF Runs
// =============================================================================

export const tfRuns = pgTable("tf_runs", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  previewId: uuid("preview_id")
    .references(() => previews.id)
    .notNull(),
  runType: text("run_type").notNull(),
  status: text("status").notNull(),
  checkRunId: bigint("check_run_id", { mode: "number" }),
  ecsTaskArn: text("ecs_task_arn"),
  planSummary: text("plan_summary"),
  planJson: jsonb("plan_json"),
  logOutput: text("log_output"),
  outputs: jsonb("outputs"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

// =============================================================================
// Approvals (now uses BetterAuth user ID)
// =============================================================================

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  previewId: uuid("preview_id")
    .references(() => previews.id)
    .notNull(),
  userId: text("user_id")
    .references(() => user.id)
    .notNull(),
  approverLogin: text("approver_login"), // Denormalized for display
  approvedAt: timestamp("approved_at").defaultNow().notNull(),
})

// =============================================================================
// Jobs (background job queue)
// =============================================================================

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id")
    .references(() => organizations.id)
    .notNull(),
  jobType: text("job_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").default("pending").notNull(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  lockedBy: text("locked_by"),
  attempts: integer("attempts").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

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
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").default("main").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("repositories_github_id").on(t.githubId)],
)
