# Terraform Execution Flow

Technical specification for Yaffle's Terraform execution system, including
DAG-based coordination, approval flow, and distributed execution.

## Core Principles

### 1. Database as Source of Truth

Postgres is the single source of truth for execution state. All coordination
happens through database state transitions.

### 2. UI Communicates Intent, Not Commands

The UI does NOT say "run this apply". The UI says "the user has approved this
to run". The backend decides when and how to execute based on DAG constraints.

### 3. DAG Order is Inviolable

It must be **impossible** for downstream tasks to execute before their upstream
dependencies have completed. This is enforced structurally, not just by
application logic.

### 4. Push, Not Poll for Approval

Workers do not sit idle waiting for approval. After plan completes, the task
goes dormant. When a user approves, the API queues an apply job. A scheduler
picks up queued jobs and dispatches workers.

### 5. Distributed-Ready

The coordination mechanism must work for distributed ECS tasks with no shared
memory or single coordinator process.

---

## Execution Model

### Task Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Task States                                     │
│                                                                              │
│   ┌─────────┐     ┌──────────┐     ┌───────────────┐     ┌─────────┐        │
│   │ pending │ ──► │ planning │ ──► │ awaiting_apply│ ──► │applying │        │
│   └─────────┘     └──────────┘     └───────────────┘     └─────────┘        │
│        │               │                   │                   │            │
│        │               ▼                   │                   ▼            │
│        │          ┌─────────┐              │             ┌──────────┐       │
│        │          │ failed  │              │             │ applied  │       │
│        │          └─────────┘              │             └──────────┘       │
│        │               │                   │                   │            │
│        ▼               ▼                   │                   │            │
│   ┌─────────┐                              │                   │            │
│   │ skipped │ ◄────────────────────────────┴───────────────────┘            │
│   └─────────┘   (downstream of any failure)                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### DAG Execution Gate

Each task has:
- **Task ID**: Unique identifier (workspace path within a run group)
- **Upstream IDs**: Set of task IDs this task depends on
- **Completed Upstreams**: Set of upstream task IDs that have finished successfully

**Execution Rule**: A task may only begin execution when:
```
completed_upstreams ⊇ upstream_ids
```

That is, every upstream task ID must be present in the completed set. This is
checked atomically at job dispatch time.

When an upstream task completes successfully:
1. It adds its ID to the `completed_upstreams` set of all downstream tasks
2. Any downstream task where `completed_upstreams = upstream_ids` becomes eligible

When an upstream task fails:
1. All downstream tasks transition directly to `skipped`
2. They never become eligible for execution

---

## Database Schema

### Run Groups

A run group represents a single execution of the DAG (one webhook event).

```sql
CREATE TABLE run_groups (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  repo TEXT NOT NULL,
  pr_number INTEGER,              -- NULL for branch deploys
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  trigger TEXT NOT NULL,          -- 'pull_request', 'push', 'manual'
  status TEXT NOT NULL,           -- 'pending', 'running', 'completed', 'failed'
  dependency_graph JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

### Dependency Graph (JSONB)

```json
{
  "workspaces": ["infra/shared", "apps/control-plane/infra", "apps/web/infra"],
  "edges": [
    ["apps/control-plane/infra", "infra/shared"],
    ["apps/web/infra", "infra/shared"]
  ]
}
```

Edges are `[downstream, upstream]` pairs. `apps/control-plane/infra` depends on
`infra/shared`.

Only **same-repo** Yaffle module references are stored in this graph. Cross-repo
module sources are treated as external Terraform dependencies and do not become
run-group edges. Cross-org module sharing is not supported.

### Previews (Tasks)

Each preview represents one workspace's execution within a run group.

```sql
CREATE TABLE previews (
  id UUID PRIMARY KEY,
  run_group_id UUID NOT NULL REFERENCES run_groups(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  workspace_path TEXT NOT NULL,
  
  -- DAG coordination
  upstream_ids TEXT[] NOT NULL DEFAULT '{}',      -- Task IDs we depend on
  completed_upstreams TEXT[] NOT NULL DEFAULT '{}', -- Upstreams that finished
  
  -- Execution state
  status TEXT NOT NULL,           -- See state machine above
  require_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  
  -- Metadata
  head_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  state_key TEXT NOT NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  UNIQUE(run_group_id, workspace_path)
);

-- Index for finding eligible tasks
CREATE INDEX idx_previews_eligible ON previews(run_group_id, status) 
  WHERE status IN ('pending', 'awaiting_apply');
```

### Job Queue

Jobs are discrete units of work dispatched to workers.

```sql
CREATE TABLE iac_jobs (
  id UUID PRIMARY KEY,
  preview_id UUID NOT NULL REFERENCES previews(id),
  job_type TEXT NOT NULL,         -- 'plan', 'apply', 'destroy'
  status TEXT NOT NULL,           -- 'queued', 'dispatched', 'running', 
                                  -- 'completed', 'failed', 'cancelled'
  worker_id TEXT,                 -- Claimed by which worker
  last_heartbeat TIMESTAMPTZ,     -- For stale job detection
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,                   -- Output, errors, etc.
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3
);

-- Index for claiming work
CREATE INDEX idx_jobs_queued ON iac_jobs(queued_at) 
  WHERE status = 'queued';
```

**Job Status Lifecycle**:
- `queued`: Waiting for scheduler to claim
- `dispatched`: Claimed by scheduler, engine starting
- `running`: Engine executing terraform
- `completed`: Finished successfully
- `failed`: Finished with error
- `cancelled`: Cancelled (e.g., PR closed while job pending)

---

## Execution Flow

### Phase 1: Webhook Receipt

1. Webhook received (PR opened, push to main, etc.)
2. Parse `yaffle.toml` from repo to get the workspace list
3. Scan Terraform files for Yaffle module sources and build a DAG from
   same-repo references only
4. Create run group with dependency graph
5. Create preview records for all workspaces
   - Compute `upstream_ids` from dependency graph
   - Root tasks (no upstreams) get `upstream_ids = '{}'`
6. Queue plan jobs for root tasks only

### Phase 2: Plan Execution

1. Worker claims queued plan job
2. Execute `terraform init` + `terraform plan`
3. On completion:
   - **Success, no changes**: Mark preview `applied`, notify downstreams
   - **Success, has changes**: Mark preview `awaiting_apply`
   - **Failure**: Mark preview `failed`, mark downstream previews `skipped`

### Phase 3: Downstream Notification

When a task completes successfully:

1. Find all downstream tasks (from dependency graph)
2. Add completing task's ID to each downstream's `completed_upstreams`
3. For any downstream where `completed_upstreams = upstream_ids`:
   - If status is `pending`: Queue a plan job
   - (Apply jobs are only queued on approval, not automatically)

### Phase 4: User Approval

User approves via UI (clicks Approve or timer expires):

1. API receives approval request
2. Validate preview is in `awaiting_apply` state
3. Re-verify all upstreams are still `applied` (handle concurrent failures)
4. Record approval (`approved_at`, `approved_by`)
5. Queue apply job
6. Update preview status to `applying` when job starts

### Manual Rerun

User clicks "Run Again" in UI to retry a failed or stale workspace:

1. API validates no pending jobs exist for this preview
2. Create new run group with `trigger: 'manual'`
3. Update preview's `run_group_id` to the new group
4. Reset preview status to `pending`
5. Clear approval state (`approved_at`, `approved_by`)
6. Queue a plan job
7. Scheduler picks up job respecting concurrency limits

**Important**: Manual rerun only reruns the single workspace, not its
dependencies. If upstream failures caused the original failure, the user
should rerun the upstream workspace first.

### Phase 5: Apply Execution

1. Worker claims queued apply job
2. Execute `terraform apply`
3. On completion:
   - **Success**: Mark preview `applied`, notify downstreams
   - **Failure**: Mark preview `failed`, mark downstream previews `skipped`

---

## Scheduler

The scheduler is a lightweight background process that bridges the job queue
and IaC Engine instances. It does NOT execute Terraform itself.

### Responsibilities

1. **Poll for queued jobs** - periodically check DB for `status = 'queued'`
2. **Spawn IaC Engine instances** - start an engine instance for each job
3. **Monitor job health** - detect stuck/timed-out jobs
4. **Enforce concurrency limits** - global and per-run-group
5. **Fair scheduling** - round-robin across run groups

### Concurrency Control

The scheduler enforces two levels of concurrency limits:

| Limit | Default (Dev) | Default (Prod) | Environment Variable |
|-------|---------------|----------------|---------------------|
| Global max concurrent | 5 | 50 | `YAFFLE_MAX_CONCURRENT_JOBS` |
| Per-run-group max | 3 | 3 | `YAFFLE_MAX_JOBS_PER_RUN_GROUP` |

**Why per-run-group limits?** Prevents one large DAG from starving others.
Multiple PRs or environments can make progress concurrently.

**Round-robin fairness**: When claiming jobs, the scheduler rotates through
run groups, taking one job from each before returning to the first. This
ensures no single run group monopolizes available slots.

### Job Priority

Within each run group, jobs are claimed in priority order:

1. **`apply`** - User-approved changes, highest priority
2. **`destroy`** - Cleanup operations
3. **`plan`** - Informational, lowest priority

This ensures that when a user approves an apply, it doesn't wait behind
queued plans for other workspaces in the same run group. Priority is enforced
at the database level using `ORDER BY` in the claim query, so it works
correctly with `FOR UPDATE SKIP LOCKED`.

### Job Dispatch Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Scheduler                                      │
│                                                                              │
│   1. Count active jobs globally - return early if at global limit           │
│   2. Get list of run_group_ids with queued work                             │
│   3. Count active jobs per run group                                        │
│   4. For each group with available capacity:                                │
│      - Query top N jobs ordered by (job_type priority, queued_at)          │
│      - Uses FOR UPDATE SKIP LOCKED (priority ordering in PostgreSQL!)      │
│   5. Round-robin interleave jobs from all groups                            │
│   6. Mark selected jobs as 'dispatched'                                     │
│   7. Spawn IaC Engine instance for each job (in parallel)                   │
│   8. Emit metrics (claimed, blocked, skip_locked_misses)                    │
│   9. Sleep, repeat                                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          IaC Engine Instance                                 │
│                                                                              │
│   1. Start with job_id                                                      │
│   2. Fetch job details from DB                                              │
│   3. Mark job as 'running'                                                  │
│   4. Execute terraform (init, plan, or apply)                               │
│   5. Record result in DB                                                    │
│   6. Mark job as 'completed' or 'failed'                                    │
│   7. Notify downstreams (queue next jobs if ready)                          │
│   8. Exit                                                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Why per-group queries?** This approach fixes a subtle bug with priority
ordering. If we query all jobs globally with `ORDER BY queued_at`, then sort
by priority in application code, `FOR UPDATE SKIP LOCKED` may skip
high-priority jobs locked by another scheduler and return lower-priority ones.
By ordering by priority *in PostgreSQL*, `SKIP LOCKED` skips lower-priority
jobs when high-priority ones are locked.

### Stale Job Recovery

If an IaC Engine instance dies without completing:

1. Job stays in `running` or `dispatched` state
2. Scheduler detects no heartbeat for N minutes
3. Scheduler re-queues job (if retries remain) or marks as `failed`

### Telemetry

The scheduler emits the following metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `yaffle.scheduler.jobs.claimed` | Counter | Jobs claimed for dispatch |
| `yaffle.scheduler.jobs.blocked` | Counter | Jobs blocked (by `reason`: `global_limit` or `group_limit`) |
| `yaffle.scheduler.jobs.active` | Gauge | Current active jobs count |
| `yaffle.scheduler.jobs.queued` | Gauge | Current queued jobs count |
| `yaffle.scheduler.groups.queued` | Gauge | Run groups with queued work |
| `yaffle.scheduler.poll.duration` | Histogram | Poll cycle duration in ms |
| `yaffle.scheduler.poll.groups_queried` | Histogram | Group queries per poll cycle |
| `yaffle.scheduler.poll.jobs_fetched` | Histogram | Jobs fetched per poll cycle |
| `yaffle.scheduler.claim.skip_locked_misses` | Counter | Jobs skipped due to lock contention |

### Scaling Characteristics

The current scheduler implementation is designed for:
- Up to ~100 concurrent run groups with queued work
- Up to ~1000 queued jobs total
- 1-3 scheduler instances

**Metrics to watch for scaling issues:**

| Metric | Warning Threshold | Indicates |
|--------|-------------------|-----------|
| `poll.duration` p99 | > 200ms | Query performance degrading |
| `groups.queued` | > 50 consistently | May need query batching |
| `poll.groups_queried` | > 20 consistently | Consider LATERAL join optimization |
| `skip_locked_misses` / `jobs_fetched` | > 0.3 | High contention between schedulers |

**If scaling issues arise, consider:**
1. Increase poll interval (reduces DB load, increases latency)
2. Implement LATERAL join optimization (single query for all groups)
3. Add a dedicated `job_queue` table with materialized priority

### Key Properties

- **No idle compute**: Engine instances are ephemeral, spawn on demand
- **Scheduler is stateless**: All state in DB, scheduler can restart safely
- **Approvals are push-based**: Scheduler does not poll for approvals; 
  the approval API queues the job directly
- **Concurrency controlled**: Global and per-group limits prevent overload
- **Fair**: Round-robin prevents starvation across run groups

---

## IaC Engine

The IaC Engine is the compute unit that executes Terraform commands. Each
instance runs exactly one job then exits.

### Execution Environment

- Receives job_id at startup
- Fetches job details and preview context from DB
- Clones repo at specific SHA
- Configures Terraform backend
- Runs terraform commands
- Streams logs to DB
- Records result and exits

### Implementations

| Environment | Implementation |
|-------------|----------------|
| Local dev | Child process spawned by scheduler |
| Production | Container instance (ECS Fargate, etc.) |
| BYOA | Customer-hosted runner with callback |

### Heartbeat

Engine instances send periodic heartbeats while running:

- Update `jobs.last_heartbeat` timestamp
- Scheduler uses this to detect dead instances
- No heartbeat for N minutes = assumed dead

---

## Configuration

### Workspace Settings

The current configuration format lives in `yaffle.toml`. See
`https://yaffle.dev/docs/reference/configuration/` for the full reference.

```toml
# yaffle.toml
version = 1

[[environments]]
name = "main"

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[triggers.github.pull_request]]
branch_pattern = "*"

[[workspaces]]
path = "infra/shared"
environments = ["main"]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["*"]

[[workspaces]]
path = "apps/production/infra"
environments = ["main"]

[[approvals]]
workspaces = ["apps/production/infra"]
environments = ["main"]
approvers = [
  "github:team:acme/platform",
  "github:team:acme/oncall-sre",
]
```

Dependencies such as `apps/control-plane/infra` -> `infra/shared` are still
auto-detected from Terraform/module references; `yaffle.toml` only declares
which workspaces and environments Yaffle manages.

### Approval Behavior

`previews.require_approval` is derived from matching `[[approvals]]` rules in
`yaffle.toml`.

| Config state | UI Behavior | Approval Trigger |
|--------------|-------------|------------------|
| No matching `[[approvals]]` rule (or `approvers = []`) | 10-second countdown timer | Timer expiry OR manual click |
| Matching `[[approvals]]` rule with one or more approvers | Approve button only | Manual click only |

---

## Error Handling

### Plan Failure

1. Preview status → `failed`
2. All downstream previews → `skipped` (cascading)
3. Run group continues processing independent branches

### Apply Failure

1. Preview status → `failed`  
2. All downstream previews → `skipped` (cascading)
3. Terraform state may be partially applied
4. Manual intervention may be required

### Engine Failure

1. Job stays in `running` state
2. Scheduler detects stale job (no heartbeat)
3. Job re-queued or marked failed based on retry count

### Upstream Failure During Approval

If user approves but an upstream failed concurrently:

1. Approval API re-checks upstream status
2. If any upstream is `failed`: reject approval, mark preview `skipped`
3. User sees error in UI

---

## Invariants

These properties must always hold:

1. **No task executes before its upstreams complete**
   - Enforced by: `completed_upstreams ⊇ upstream_ids` check at job dispatch

2. **Failed upstreams cascade to skip downstreams**
   - Enforced by: Failure handler immediately marks all transitive downstreams

3. **Each task executes at most once per run group**
   - Enforced by: `UNIQUE(run_group_id, workspace_path)` constraint

4. **Jobs are processed exactly once**
   - Enforced by: `FOR UPDATE SKIP LOCKED` + status transitions

5. **Approval is recorded before apply executes**
   - Enforced by: Apply job only queued after approval recorded in DB
