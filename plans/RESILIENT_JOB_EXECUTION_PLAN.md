# Resilient Job Execution System

## Problem Statement

The current job execution system has several critical reliability issues:

1. **Workers don't survive CP restarts** - Local workers run as in-process async promises. When the control plane restarts (HMR, deployment, crash), all in-flight jobs are orphaned.

2. **"Dispatched but never started" state** - Jobs get marked `dispatched` when the scheduler spawns a worker, but if the worker never starts (process spawn fails, crash on startup), the job is stuck forever.

3. **Auto-requeue causes duplicate runs** - The stale job detector would requeue jobs, potentially causing two workers to run the same terraform operation simultaneously, leading to state lock conflicts and corruption.

4. **Different patterns for Local vs ECS** - Local runs in-process, ECS spawns tasks. Different failure modes, harder to reason about.

5. **Backpressure cascades** - Each stuck job blocks downstream workspaces, compounding the problem.

## Design Principles

1. **Workers are independent processes** - Must survive CP restarts/HMR/deployments
2. **Same pattern for all executors** - Local spawns child process, ECS spawns Fargate task, both behave identically
3. **Database is source of truth** - All coordination via atomic DB operations (through API)
4. **Scale to zero** - Workers spawned on demand, exit when done
5. **API-only communication** - Workers never touch DB directly; use scoped job tokens
6. **Never auto-requeue** - Stale jobs fail and require manual retry to avoid duplicate runs
7. **S3 workspace cache** - Clone once on webhook, reuse workspace tarball for all jobs

## Job States

### Current (Problematic)

```
queued → dispatched → running → completed/failed
            │
            └── (stuck here if worker never starts)
```

### New (Simplified)

```
queued → running → completed/failed
```

The `dispatched` state is removed entirely. Jobs go directly from `queued` to `running` when the worker atomically claims them.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Control Plane                             │
│                                                                  │
│  ┌─────────────┐     ┌─────────────┐     ┌──────────────────┐  │
│  │  Scheduler  │     │  Runner API │     │ Completion Poller│  │
│  │             │     │  /claim     │     │ (stale detection)│  │
│  │  - Polls    │     │  /heartbeat │     │                  │  │
│  │  - Spawns   │     │  /complete  │     │  - Fails stale   │  │
│  └──────┬──────┘     └──────┬──────┘     └────────┬─────────┘  │
│         │                   │                     │             │
└─────────┼───────────────────┼─────────────────────┼─────────────┘
          │                   ▲                     │
          │ spawn             │ API calls           │ poll DB
          ▼                   │                     ▼
┌─────────────────────────────┴───────────────────────────────────┐
│                                                                  │
│  ┌──────────────────┐              ┌──────────────────┐         │
│  │  Local Worker    │              │   ECS Worker     │         │
│  │  (child process) │              │   (Fargate task) │         │
│  │                  │              │                  │         │
│  │  ┌────────────┐  │              │  ┌────────────┐  │         │
│  │  │ Heartbeat  │  │              │  │ Heartbeat  │  │         │
│  │  │ Supervisor │  │              │  │ Supervisor │  │         │
│  │  └─────┬──────┘  │              │  └─────┬──────┘  │         │
│  │        │         │              │        │         │         │
│  │  ┌─────▼──────┐  │              │  ┌─────▼──────┐  │         │
│  │  │ tofu/      │  │              │  │ tofu/      │  │         │
│  │  │ complete   │  │              │  │ complete   │  │         │
│  │  └────────────┘  │              │  └────────────┘  │         │
│  └──────────────────┘              └──────────────────┘         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Process Flows

### Webhook Flow (Workspace Caching)

```
on webhook (PR opened/sync, push):
  1. Fetch yaffle.toml via GitHub API (no clone needed)
  2. Clone repo (shallow) for dependency scanning
  3. Scan terraform module dependencies
  4. Upload workspace tarball to S3: {org}/{repo}/{sha}/workspace.tar.gz
  5. Store workspace_s3_key in run_groups table
  6. Delete local clone
  7. Queue jobs for root workspaces
```

**Key insight:** Workspace is cloned ONCE per SHA and cached in S3. All jobs for that SHA (across multiple workspaces, multiple PRs) share the same cached workspace.

### Scheduler Loop (Control Plane)

```
every 1 second:
  1. Query for queued jobs respecting concurrency limits
  2. For each job to spawn:
     a. Generate job token (scoped to job ID, tied to job lifecycle)
     b. Call spawner.spawn(jobId, jobToken)
     c. Job stays "queued" - worker will claim it atomically
  3. Log spawned jobs for observability
```

**Key change:** Scheduler does NOT update job status. It only spawns workers. The worker is responsible for claiming.

### Worker Lifecycle

```
main() {
  # 1. Claim job atomically via API
  claim_job || exit 0  # Exit gracefully if another worker got it
  
  # 2. Fetch execution context from API
  context = GET /api/runner/job/{id}/context
  
  # 3. Setup
  download_workspace(context.workspaceUrl)  # From S3
  configure_backend(context.backendConfig)
  configure_variables(context.variables)
  
  # 4. Execute tofu under heartbeat supervision
  if ! supervised_exec "tofu" run_tofu_command; then
    supervised_exec "completion" report_failure
    exit 1
  fi
  
  # 5. Report success under heartbeat supervision
  supervised_exec "completion" report_success
}
```

**Critical:** Workers execute terraform via shell commands, NOT by importing control plane code. Workers have no database access.

### Heartbeat Supervisor Pattern

The heartbeat supervisor is the parent process that:
1. Spawns the child work (tofu, completion call)
2. Sends heartbeats to CP while child is running
3. Kills the child if heartbeat fails (job was reclaimed or CP unreachable)
4. Returns the child's exit code when it completes

```bash
supervised_exec() {
  local description=$1
  shift
  local cmd=("$@")
  
  # Run command in background
  "${cmd[@]}" &
  local child_pid=$!
  
  # Supervise: heartbeat while child runs
  while true; do
    # Check if child is still running
    if ! kill -0 "$child_pid" 2>/dev/null; then
      # Child finished, get exit code
      wait $child_pid
      return $?
    fi
    
    # Send heartbeat (with retry)
    if ! heartbeat_with_retry; then
      log "Heartbeat failed, killing $description"
      kill "$child_pid" 2>/dev/null || true
      wait $child_pid 2>/dev/null || true
      return 1
    fi
    
    sleep 30
  done
}

heartbeat_with_retry() {
  local max_attempts=3
  for ((i=1; i<=max_attempts; i++)); do
    if curl -sf -X POST "$YAFFLE_API_URL/api/runner/heartbeat" \
         -H "Authorization: Bearer $YAFFLE_RUN_TOKEN" \
         -H "Content-Type: application/json" \
         -d "{\"jobId\": \"$YAFFLE_JOB_ID\"}"; then
      return 0
    fi
    sleep 5
  done
  return 1
}
```

This ensures:
- Heartbeats are sent for the entire duration of active work (tofu AND completion call)
- No gap between tofu finishing and completion call where job could be marked stale
- If CP stops accepting heartbeats (job reclaimed), the child work is killed immediately
- If the child crashes, heartbeats stop and the job is properly failed

### Completion Poller (Control Plane)

```
every 30 seconds:
  1. Find stale jobs:
     - status = 'running'
     - never heartbeated AND started > 2 minutes ago
     - OR last_heartbeat > 5 minutes ago
  
  2. For each stale job:
     a. Mark as failed: "Worker stopped responding"
     b. Update deployment status
     c. Cascade failure to downstream workspaces
     d. Emit events for UI update
```

### CP Startup Recovery

```
on control plane startup:
  1. Find orphaned jobs:
     - status = 'running'
     - last_heartbeat > 5 minutes ago (or null and started > 2 min ago)
  
  2. For each orphaned job:
     a. Mark as failed: "Job orphaned during control plane restart"
     b. Update deployment status
     c. Cascade failure to downstreams
  
  Note: Jobs with recent heartbeats are left alone - worker may still be running
```

## Runner API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/runner/claim` | Atomically claim job (`queued` → `running`) |
| `GET /api/runner/job/:id/context` | Get execution context (workspace URL, variables, backend config) |
| `POST /api/runner/heartbeat` | Update `last_heartbeat` timestamp |
| `POST /api/runner/logs` | Stream log chunks from terraform execution |
| `POST /api/runner/complete` | Report completion, trigger downstream effects |

### Authentication

Job tokens are:
- Generated by the scheduler when spawning a worker
- Scoped to a single job ID (can only operate on that job)
- Tied to job lifecycle (invalidated when job completes/fails)
- Cannot access any other API endpoints

### Claim Endpoint

```typescript
// POST /api/runner/claim
// Body: { jobId: string }
// Auth: Bearer <run_token>

async function claimJob(jobId: string, workerId: string) {
  const result = await db
    .update(iacJobs)
    .set({
      status: 'running',
      workerId,
      startedAt: new Date(),
    })
    .where(and(
      eq(iacJobs.id, jobId),
      eq(iacJobs.status, 'queued'),  // Atomic: only if still queued
    ))
    .returning()
  
  return { claimed: result.length > 0, job: result[0] }
}
```

### Heartbeat Endpoint

```typescript
// POST /api/runner/heartbeat
// Body: { jobId: string }
// Auth: Bearer <run_token>

async function heartbeat(jobId: string, workerId: string) {
  const result = await db
    .update(iacJobs)
    .set({ lastHeartbeat: new Date() })
    .where(and(
      eq(iacJobs.id, jobId),
      eq(iacJobs.workerId, workerId),  // Only if we still own it
      eq(iacJobs.status, 'running'),
    ))
    .returning()
  
  return { success: result.length > 0 }
}
```

### Context Endpoint

```typescript
// GET /api/runner/job/:id/context
// Auth: Bearer <job_token>

// Returns everything the worker needs to execute the job:
{
  workspaceUrl: string       // Presigned S3 download URL (15 min expiry)
  command: "plan" | "apply" | "destroy"
  workspacePath: string      // Subdirectory within workspace tarball
  variables: Record<string, string | boolean | number>
  backendConfig?: {
    hostname: string         // TFC API host
    organization: string     // Org slug
    workspaceName: string    // TFC workspace name
  }
  tfcToken?: string          // TFC token for state access
}
```

This endpoint:
1. Looks up the job and deployment
2. Generates presigned S3 URL for workspace download
3. Renders variables with template context
4. Generates TFC token if using TFC backend
5. Returns everything needed for execution

### Logs Endpoint

```typescript
// POST /api/runner/logs
// Body: { jobId: string, chunk: string, source: 'stdout' | 'stderr' }
// Auth: Bearer <job_token>

// Appends log chunk to tf_run_logs table
// Emits SSE event for real-time UI updates
```

### Complete Endpoint

```typescript
// POST /api/runner/complete
// Body: { jobId: string, status: 'completed' | 'failed', result?: object, error?: string }
// Auth: Bearer <job_token>

async function completeJob(jobId: string, workerId: string, status: string, result?: object, error?: string) {
  const updated = await db
    .update(iacJobs)
    .set({
      status,
      completedAt: new Date(),
      result,
      errorMessage: error,
    })
    .where(and(
      eq(iacJobs.id, jobId),
      eq(iacJobs.workerId, workerId),
      eq(iacJobs.status, 'running'),
    ))
    .returning()
  
  if (updated.length > 0) {
    // Trigger side effects
    await updateDeploymentStatus(...)
    await notifyDownstreams(...)  // or cascadeFailure
    await invalidateJobToken(jobId)
  }
  
  return { success: updated.length > 0 }
}
```

## Stale Detection Thresholds

| Condition | Threshold | Action |
|-----------|-----------|--------|
| `running`, never heartbeated | 2 minutes | Mark failed |
| `running`, heartbeat stopped | 5 minutes | Mark failed |

**No auto-requeue.** User must manually retry via "Run Again" button.

This is intentional because:
1. Terraform applies can legitimately take 10+ minutes without output
2. Auto-requeue can cause duplicate runs and state lock conflicts
3. It's safer to fail and let humans investigate

## Spawner Implementations

Both spawners pass exactly the same environment variables. The worker fetches everything else from the API.

### LocalChildProcessSpawner

```typescript
class LocalChildProcessSpawner implements IacEngineSpawner {
  async spawn(jobId: string, jobToken: string): Promise<void> {
    const child = spawn('bun', ['run', 'apps/runner/src/worker.ts'], {
      detached: true,      // Survives parent death
      stdio: 'ignore',     // No pipe to parent
      env: {
        ...process.env,
        YAFFLE_JOB_ID: jobId,
        YAFFLE_JOB_TOKEN: jobToken,
        YAFFLE_API_URL: process.env.YAFFLE_API_URL ?? 'http://localhost:3000',
      },
    })
    child.unref()  // Don't wait for child
    
    logger.info("Spawned local worker", { jobId, pid: child.pid })
  }
}
```

### EcsEngineSpawner

```typescript
class EcsEngineSpawner implements IacEngineSpawner {
  async spawn(jobId: string, jobToken: string): Promise<void> {
    const result = await this.ecs.send(new RunTaskCommand({
      cluster: this.config.clusterArn,
      taskDefinition: this.config.taskDefinition,
      // ... networking config
      overrides: {
        containerOverrides: [{
          name: "runner",
          environment: [
            { name: "YAFFLE_JOB_ID", value: jobId },
            { name: "YAFFLE_JOB_TOKEN", value: jobToken },
            { name: "YAFFLE_API_URL", value: this.config.apiUrl },
            // Worker fetches workspace URL, variables, backend config from API
          ],
        }],
      },
    }))
    
    logger.info("Spawned ECS task", { jobId, taskArn: result.tasks[0].taskArn })
  }
}
```

**Key point:** Both spawners are nearly identical. The only difference is HOW they spawn (child process vs ECS task). The worker behavior is 100% identical.

## Failure Modes & Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Worker never starts | No claim within 2 min | Completion poller marks failed |
| Worker dies mid-execution | Heartbeat stops | Completion poller marks failed after 5 min |
| Worker completes but can't reach API | Heartbeat stops | Completion poller marks failed |
| CP restarts while worker running | Worker continues, heartbeats to new CP | No action needed |
| CP restarts, worker dead | Startup recovery finds orphaned jobs | Mark failed |
| Two workers spawned for same job | Only one wins atomic claim | Loser exits gracefully (exit 0) |
| Heartbeat fails (network blip) | Worker retries 3x | If still failing, worker aborts |
| Terraform state lock conflict | tofu fails with lock error | Job fails, user sees clear error |

## Decisions Made

1. **No `dispatched` state** - Jobs go directly `queued` → `running` via atomic claim
2. **Workers are independent processes** - Survive CP restarts
3. **API-only communication** - Workers never access DB directly (security)
4. **Job tokens tied to job lifecycle** - No separate TTL, invalidated on job completion
5. **Heartbeat supervisor pattern** - Heartbeat is parent of tofu/completion, ensures no gaps
6. **30 second heartbeat interval** - Balance between freshness and overhead
7. **Heartbeat retries 3x before aborting** - Tolerate transient network issues
8. **Never auto-requeue** - Stale jobs fail, require manual retry
9. **Local worker uses `bun run`** - TypeScript, matches dev environment
10. **Runner code lives in `apps/runner/`** - Shared between local and ECS
11. **S3 workspace cache** - Workspace uploaded once per SHA, shared by all jobs
12. **Worker fetches context from API** - Minimal env vars, worker calls API for execution details
13. **Shell-based terraform execution** - Workers run `tofu` via shell, not via imported CP code
14. **Log streaming via API** - Workers POST log chunks, CP stores and emits SSE events

## Infrastructure

### S3 Workspace Cache Bucket

```hcl
# apps/control-plane/infra/workspace-cache.tf

resource "aws_s3_bucket" "workspace_cache" {
  bucket = "yaffle-workspace-cache-${var.environment}-${var.aws_region}"
}

resource "aws_s3_bucket_lifecycle_configuration" "workspace_cache" {
  bucket = aws_s3_bucket.workspace_cache.id

  rule {
    id     = "expire-old-workspaces"
    status = "Enabled"

    expiration {
      days = 7
    }
  }
}
```

**S3 Key Structure:** `{org}/{repo}/{sha}/workspace.tar.gz`

- Same SHA = same workspace (cached across PRs)
- 7-day lifecycle policy auto-deletes old workspaces

**IAM:**
- Control plane: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`
- Runner (ECS): `s3:GetObject` (read-only, downloads only)

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `apps/runner/src/worker.ts` | TypeScript worker entry point |
| `apps/runner/src/lib/api-client.ts` | HTTP client for runner API calls |
| `apps/runner/src/lib/supervisor.ts` | Heartbeat supervisor logic |
| `apps/runner/src/lib/executor.ts` | Shell-based terraform execution |
| `apps/runner/src/lib/workspace.ts` | S3 download, tarball extraction |
| `apps/runner/package.json` | Runner package config |
| `apps/control-plane/src/routes/runner.ts` | Runner API endpoints |
| `apps/control-plane/src/lib/local-spawner.ts` | Local child process spawner |
| `apps/control-plane/src/lib/job-token.ts` | Job token generation/validation |
| `apps/control-plane/src/lib/workspace-cache.ts` | S3 workspace upload/download |
| `apps/control-plane/infra/workspace-cache.tf` | S3 bucket + IAM for workspace cache |

### Modified Files

| File | Changes |
|------|---------|
| `apps/control-plane/src/lib/webhook-handler.ts` | Upload workspace to S3 after dependency scan |
| `apps/control-plane/src/lib/scheduler.ts` | Generate job tokens, use new spawner |
| `apps/control-plane/src/lib/ecs-spawner.ts` | Simplify to only pass job ID, token, API URL |
| `apps/control-plane/src/db/schema.ts` | Add `workspaceS3Key` to run_groups |
| `apps/control-plane/src/db/queries/iac-jobs.ts` | Add claim/heartbeat/complete/context functions |
| `nix/runner.nix` | Include TypeScript worker and Bun runtime |
| `flake.nix` | Update runner-image to use Bun + TypeScript |

### Removed

| Item | Reason |
|------|--------|
| `dispatched` job status | No longer needed with atomic claiming |
| `apps/runner/entrypoint.sh` | Replaced by TypeScript worker |
| `apps/control-plane/src/lib/iac-engine-standalone.ts` | Workers use shell execution, not DB imports |
| Legacy `LocalEngineSpawner` | Replaced with `LocalChildProcessSpawner` |

## Implementation Order

### Phase 1: Infrastructure (S3 Workspace Cache)

1. Create `apps/control-plane/infra/workspace-cache.tf`
   - S3 bucket with 7-day lifecycle
   - KMS encryption
   - IAM policies for CP (read/write) and runner (read-only)

2. Add `workspaceS3Key` column to `run_groups` table

### Phase 2: Workspace Upload (Webhook Handler)

3. Create `apps/control-plane/src/lib/workspace-cache.ts`
   - `uploadWorkspace(org, repo, sha, tarballPath)` → S3 key
   - `getWorkspaceUrl(s3Key)` → presigned URL

4. Modify `apps/control-plane/src/lib/webhook-handler.ts`
   - After `scanDependencies()`, upload workspace tarball to S3
   - Store S3 key in run group

### Phase 3: Runner API Endpoints

5. Add `GET /api/runner/job/:id/context` endpoint
   - Returns workspace URL, variables, backend config, TFC token

6. Add `POST /api/runner/logs` endpoint
   - Appends to `tf_run_logs`, emits SSE events

### Phase 4: Worker Refactoring

7. Create `apps/runner/src/lib/executor.ts`
   - Shell-based terraform execution (tofu init, plan, apply, destroy)
   - Output parsing (plan summary, outputs)

8. Create `apps/runner/src/lib/workspace.ts`
   - S3 download via presigned URL
   - Tarball extraction

9. Rewrite `apps/runner/src/worker.ts`
   - Remove `iac-engine-standalone.ts` import
   - Fetch context from API
   - Download workspace from S3
   - Execute via shell
   - Stream logs via API

### Phase 5: Spawner Updates

10. Update `apps/control-plane/src/lib/local-spawner.ts`
    - Only pass: `YAFFLE_JOB_ID`, `YAFFLE_JOB_TOKEN`, `YAFFLE_API_URL`

11. Update `apps/control-plane/src/lib/ecs-spawner.ts`
    - Remove workspace packaging (now done at webhook time)
    - Only pass: `YAFFLE_JOB_ID`, `YAFFLE_JOB_TOKEN`, `YAFFLE_API_URL`

### Phase 6: Cleanup

12. Delete obsolete files:
    - `apps/runner/entrypoint.sh`
    - `apps/control-plane/src/lib/iac-engine-standalone.ts`

13. Update nix2container:
    - `nix/runner.nix` - Include Bun and TypeScript worker
    - `flake.nix` - Update runner-image entrypoint

### Phase 7: Testing

14. Test local runner end-to-end
    - Verify workspace upload/download
    - Verify log streaming
    - Verify completion

15. Test ECS runner with Tailscale
    - Configure `YAFFLE_API_URL` to Tailscale hostname
    - Verify ECS task can reach local CP

## Testing Strategy

1. **Unit tests** for runner API endpoints (claim atomicity, heartbeat, complete, context, logs)
2. **Unit tests** for supervisor pattern (child monitoring, heartbeat failure)
3. **Unit tests** for shell executor (tofu commands, output parsing)
4. **Integration test**: workspace upload/download via S3
5. **Integration test**: spawn local worker, verify full flow
6. **Integration test**: simulate CP restart, verify worker continues
7. **Integration test**: simulate worker death, verify stale detection
8. **Integration test**: simulate two workers for same job, verify only one wins
9. **Integration test**: log streaming from worker to UI

## Network Configuration

### Local Development

Workers run as local child processes. API URL is `http://localhost:3000` (or via Caddy HTTPS).

### ECS with Local CP (Development/Testing)

Use Tailscale to connect ECS tasks to local development machine:

```
YAFFLE_API_URL=https://{machine}.tail66f312.ts.net:3000
```

ECS task joins Tailscale network via sidecar container with Tailscale OAuth.

### Production

ECS tasks reach CP via internal ALB or service discovery within VPC.

## Future Enhancements

1. **Compiled worker binary** - Faster startup, no runtime dependency
2. **Separate runner API service** - Network isolation, CP downtime survivability
3. **Worker pool mode** - Pre-warmed workers for lower latency
4. **ECS task status polling** - Fallback if worker can't reach API
5. **Workspace deduplication** - Check if workspace already in S3 before uploading
