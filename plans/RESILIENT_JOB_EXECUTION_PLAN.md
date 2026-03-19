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
5. **API-only communication** - Workers never touch DB directly; use scoped run tokens
6. **Never auto-requeue** - Stale jobs fail and require manual retry to avoid duplicate runs

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

### Scheduler Loop (Control Plane)

```
every 1 second:
  1. Query for queued jobs respecting concurrency limits
  2. For each job to spawn:
     a. Generate run token (scoped to job ID, tied to job lifecycle)
     b. Call spawner.spawn(jobId, runToken)
     c. Job stays "queued" - worker will claim it atomically
  3. Log spawned jobs for observability
```

**Key change:** Scheduler does NOT update job status. It only spawns workers. The worker is responsible for claiming.

### Worker Lifecycle

```
main() {
  # 1. Claim job atomically via API
  claim_job || exit 0  # Exit gracefully if another worker got it
  
  # 2. Setup
  download_workspace
  configure_backend
  configure_variables
  
  # 3. Execute tofu under heartbeat supervision
  if ! supervised_exec "tofu" run_tofu_command; then
    supervised_exec "completion" report_failure
    exit 1
  fi
  
  # 4. Report success under heartbeat supervision
  supervised_exec "completion" report_success
}
```

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
| `POST /api/runner/heartbeat` | Update `last_heartbeat` timestamp |
| `POST /api/runner/complete` | Report completion, trigger downstream effects |

### Authentication

Run tokens are:
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

### Complete Endpoint

```typescript
// POST /api/runner/complete
// Body: { jobId: string, status: 'completed' | 'failed', result?: object, error?: string }
// Auth: Bearer <run_token>

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
    await invalidateRunToken(jobId)
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

### LocalEngineSpawner

```typescript
class LocalEngineSpawner implements IacEngineSpawner {
  async spawn(jobId: string, runToken: string): Promise<void> {
    const child = spawn('bun', ['run', 'apps/runner/src/worker.ts'], {
      detached: true,      // Survives parent death
      stdio: 'ignore',     // No pipe to parent
      env: {
        ...process.env,
        YAFFLE_JOB_ID: jobId,
        YAFFLE_RUN_TOKEN: runToken,
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
  async spawn(jobId: string, runToken: string): Promise<void> {
    const result = await this.ecs.send(new RunTaskCommand({
      cluster: this.config.clusterArn,
      taskDefinition: this.config.taskDefinition,
      // ... networking config
      overrides: {
        containerOverrides: [{
          name: "runner",
          environment: [
            { name: "YAFFLE_JOB_ID", value: jobId },
            { name: "YAFFLE_RUN_TOKEN", value: runToken },
            { name: "YAFFLE_API_URL", value: this.config.apiUrl },
            // ... workspace URLs, backend config, etc.
          ],
        }],
      },
    }))
    
    logger.info("Spawned ECS task", { jobId, taskArn: result.tasks[0].taskArn })
  }
}
```

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
4. **Run tokens tied to job lifecycle** - No separate TTL, invalidated on job completion
5. **Heartbeat supervisor pattern** - Heartbeat is parent of tofu/completion, ensures no gaps
6. **30 second heartbeat interval** - Balance between freshness and overhead
7. **Heartbeat retries 3x before aborting** - Tolerate transient network issues
8. **Never auto-requeue** - Stale jobs fail, require manual retry
9. **Local worker uses `bun run`** - TypeScript, matches dev environment
10. **Runner code lives in `apps/runner/`** - Shared between local and ECS

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `apps/runner/src/worker.ts` | TypeScript worker entry point |
| `apps/runner/src/lib/api-client.ts` | HTTP client for runner API calls |
| `apps/runner/src/lib/supervisor.ts` | Heartbeat supervisor logic |
| `apps/runner/package.json` | Runner package config |
| `apps/control-plane/src/routes/runner.ts` | Runner API endpoints |
| `apps/control-plane/src/lib/local-spawner.ts` | Local child process spawner |
| `apps/control-plane/src/lib/run-token.ts` | Run token generation/validation (may already exist) |

### Modified Files

| File | Changes |
|------|---------|
| `apps/runner/entrypoint.sh` | Add claim/heartbeat/complete API calls, supervisor pattern |
| `apps/control-plane/src/lib/scheduler.ts` | Generate run tokens, remove job claiming, use new spawner |
| `apps/control-plane/src/lib/ecs-spawner.ts` | Pass run token and API URL to container |
| `apps/control-plane/src/db/schema.ts` | Remove `dispatched` from status enum |
| `apps/control-plane/src/db/queries/iac-jobs.ts` | Remove `dispatched` logic, add claim/heartbeat/complete functions |
| `packages/shared/src/types.ts` | Remove `dispatched` from PreviewStatus type |

### Removed

| Item | Reason |
|------|--------|
| `dispatched` job status | No longer needed with atomic claiming |
| `LocalEngineSpawner` in scheduler.ts | Replaced with separate file using child process |
| `requeueOrFailStaleJob` | Already removed, replaced with `failStaleJob` |

## Implementation Order

1. **Add runner to monorepo workspace** - Update root `package.json` and create `apps/runner/package.json`

2. **Add runner API endpoints** - `/api/runner/claim`, `/heartbeat`, `/complete` in control-plane

3. **Create runner worker** - `apps/runner/src/worker.ts` with supervisor pattern and API client

4. **Update `entrypoint.sh`** - Add supervisor pattern and API calls for ECS compatibility

5. **Create `LocalEngineSpawner`** - Spawns detached child process with env vars

6. **Update scheduler** - Generate run tokens, use new spawner, stop claiming jobs directly

7. **Remove `dispatched` state** - Schema, queries, shared types

8. **Update ECS spawner** - Pass run token and API URL

9. **Add CP startup recovery** - Find and fail orphaned jobs on startup

10. **Update stale detection** - Verify no requeue remnants, only fails

## Testing Strategy

1. **Unit tests** for runner API endpoints (claim atomicity, heartbeat, complete)
2. **Unit tests** for supervisor pattern (child monitoring, heartbeat failure)
3. **Integration test**: spawn local worker, verify claim/heartbeat/complete flow
4. **Integration test**: simulate CP restart, verify worker continues
5. **Integration test**: simulate worker death, verify stale detection
6. **Integration test**: simulate two workers for same job, verify only one wins

## Future Enhancements

1. **Compiled worker binary** - Faster startup, no runtime dependency
2. **Separate runner API service** - Network isolation, CP downtime survivability
3. **Worker pool mode** - Pre-warmed workers for lower latency
4. **ECS task status polling** - Fallback if worker can't reach API
