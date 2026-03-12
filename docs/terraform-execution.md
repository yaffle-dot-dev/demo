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
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  preview_id UUID NOT NULL REFERENCES previews(id),
  job_type TEXT NOT NULL,         -- 'plan', 'apply', 'destroy'
  status TEXT NOT NULL,           -- 'queued', 'running', 'completed', 'failed'
  worker_id TEXT,                 -- Claimed by which worker
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB                    -- Output, errors, etc.
);

-- Index for claiming work
CREATE INDEX idx_jobs_queued ON jobs(job_type, queued_at) 
  WHERE status = 'queued';
```

---

## Execution Flow

### Phase 1: Webhook Receipt

1. Webhook received (PR opened, push to main, etc.)
2. Parse `.yaffle/config.yml` from repo
3. Scan module dependencies, build DAG
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
4. **Enforce concurrency limits** - per org, per repo, global

### Job Dispatch Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Scheduler                                      │
│                                                                              │
│   1. Poll DB: SELECT * FROM jobs WHERE status = 'queued'                    │
│   2. For each queued job:                                                   │
│      a. Check concurrency limits                                            │
│      b. Mark job as 'dispatched'                                            │
│      c. Spawn IaC Engine instance with job_id                               │
│   3. Sleep, repeat                                                          │
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

### Stale Job Recovery

If an IaC Engine instance dies without completing:

1. Job stays in `running` or `dispatched` state
2. Scheduler detects no heartbeat for N minutes
3. Scheduler re-queues job (if retries remain) or marks as `failed`

### Key Properties

- **No idle compute**: Engine instances are ephemeral, spawn on demand
- **Scheduler is stateless**: All state in DB, scheduler can restart safely
- **Approvals are push-based**: Scheduler does not poll for approvals; 
  the approval API queues the job directly

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

```yaml
# .yaffle/config.yml
version: 1
workspaces:
  - path: infra/shared
    require_approval: false    # Timer auto-approves after countdown
    
  - path: apps/control-plane/infra
    require_approval: false
    # Depends on infra/shared via module references (auto-detected)
    
  - path: apps/production/infra
    require_approval: true     # Explicit approval required, no timer
    approvers:                 # Optional: restrict who can approve
      - platform-team
      - oncall-sre
```

### Approval Behavior

| `require_approval` | UI Behavior | Approval Trigger |
|--------------------|-------------|------------------|
| `false` (default) | 10-second countdown timer | Timer expiry OR manual click |
| `true` | Approve button only | Manual click only |

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
