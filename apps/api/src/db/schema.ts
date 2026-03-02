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

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubId: bigint("github_id", { mode: "number" }).unique().notNull(),
  login: text("login").notNull(),
  stateBucket: text("state_bucket").notNull(),
  runnerMode: text("runner_mode").default("saas").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .references(() => organizations.id)
    .notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  config: jsonb("config").notNull(),
  secretArn: text("secret_arn").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

export const previews = pgTable(
  "previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id)
      .notNull(),
    installationId: bigint("installation_id", { mode: "number" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    workspacePath: text("workspace_path").notNull(),
    branch: text("branch").notNull(),
    headSha: text("head_sha").notNull(),
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

export const tfRuns = pgTable("tf_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
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

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  previewId: uuid("preview_id")
    .references(() => previews.id)
    .notNull(),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
  approverLogin: text("approver_login"),
  approvedAt: timestamp("approved_at").defaultNow().notNull(),
})

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobType: text("job_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").default("pending").notNull(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  lockedBy: text("locked_by"),
  attempts: integer("attempts").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})
