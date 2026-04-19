# Job-Based Destroy Migration Plan

Migrate destroy operations from inline execution in `webhook-handler.ts` to
job-based execution via the IaC engine, completing the transition that was
already done for plan/apply operations.

## Status

**Status: NOT STARTED**

- [ ] Phase 1: Webhook Handler Changes
- [ ] Phase 2: IaC Engine Enhancements
- [ ] Phase 3: Cleanup Dead Code
- [ ] Phase 4: Test Updates

---

## Background

### Current State

The webhook handler has evolved to use job-based execution for plan and apply:

| Operation | Execution Model | Location |
|-----------|-----------------|----------|
| Plan | Job-based | IaC engine |
| Apply | Job-based | IaC engine |
| **Destroy** | **Inline** | webhook-handler.ts |

This inconsistency means:
- `webhook-handler.ts` is ~1400 lines with mixed responsibilities
- Destroy bypasses the job queue, heartbeats, and DAG coordination
- The `executeRun` function (~240 lines) exists solely for inline destroy
- Cannot refactor webhook-handler for SRP until destroy is job-based

### Target State

All terraform operations (plan, apply, destroy) go through the IaC engine:

```
webhook-handler.ts          iac-engine.ts
─────────────────────       ─────────────────
PR opened/sync:             executeJob():
  → queue plan jobs           → run plan/apply/destroy
                              → update PR comments
PR closed:                    → handle TFC archival
  → queue destroy jobs        → notify DAG (forward or reverse)
```

### Key Design Decisions

1. **PR destroys are automatic** - no approval required for transient environments
2. **Destroy uses reverse DAG** - downstream workspaces destroyed before upstreams
3. **Implicit dependency inversion** - use existing `upstreamIds`, invert at runtime
4. **PR comments rendered from DB** - no in-memory state needed in IaC engine

---

## Phase 1: Webhook Handler Changes

**File:** `apps/control-plane/src/lib/webhook-handler.ts`

### 1a. Compute Reverse Topological Order

In `handlePrClosed`, determine which workspaces are "leaves" (no downstream
dependencies) and should be destroyed first.

```typescript
// Get all deployments for this PR environment
const deployments = await findDeploymentsByEnvironment(org.id, ctx.repo, environmentName)

// Find leaf workspaces (those with no other workspace depending on them)
const leafDeployments = deployments.filter(d => {
  const hasDownstreams = deployments.some(other => 
    other.upstreamIds.includes(d.id)
  )
  return !hasDownstreams
})
```

### 1b. Queue Destroy Jobs for Leaf Workspaces Only

Only queue destroy jobs for leaf workspaces. Non-leaf workspaces will have
their destroy jobs queued by the IaC engine when all their downstreams complete.

```typescript
for (const deployment of leafDeployments) {
  await createIacJob({
    deploymentId: deployment.id,
    jobType: "destroy",
  })
}
```

### 1c. Set Deployment Status to `pending`

Use consistent status naming with other job transitions:

```typescript
await updateDeploymentStatus(deployment.id, "pending")
```

### 1d. Cancel Pending Plan/Apply Jobs

Already exists at line 779 - keep this logic:

```typescript
const cancelledCount = await cancelJobsForPreview(preview.id)
```

### 1e. Lock TFC Workspaces Before Queueing

Move `beginWorkspaceArchive` to happen before the destroy job is queued:

```typescript
if (tfcWorkspace) {
  const locked = await beginWorkspaceArchive(tfcWorkspace.id)
  if (!locked) {
    logger.warn("Could not lock TFC workspace for archive", { ... })
    continue // Skip this workspace
  }
}

await createIacJob({ deploymentId: deployment.id, jobType: "destroy" })
```

### 1f. Remove Inline `executeRun` Call

Delete the loop that calls `executeRun` for destroy (lines 765-859).

---

## Phase 2: IaC Engine Enhancements

**File:** `apps/control-plane/src/lib/iac-engine.ts`

### 2a. Set Status to `destroying` When Job Starts

Already handled by existing status map at lines 279-284:

```typescript
const statusMap: Record<string, string> = {
  plan: "planning",
  apply: "applying",
  destroy: "destroying",
}
```

No changes needed.

### 2b. On Destroy Success: Complete TFC Archival

Add TFC workspace archival to the destroy success path:

```typescript
if (job.jobType === "destroy") {
  await updateDeploymentStatus(preview.id, "destroyed")
  
  // Archive TFC workspace if applicable
  if (tfcWorkspaceId) {
    const { completeWorkspaceArchive } = await import("./workspace-service.ts")
    await completeWorkspaceArchive(tfcWorkspaceId)
  }
}
```

### 2c. On Destroy Failure: Fail TFC Archival

Add to the failure path:

```typescript
if (job.jobType === "destroy" && tfcWorkspaceId) {
  const { failWorkspaceArchive } = await import("./workspace-service.ts")
  await failWorkspaceArchive(tfcWorkspaceId, result.errorMessage ?? "destroy failed")
}
```

### 2d. Implement Reverse DAG Notification

Add function to handle destroy completion cascading:

```typescript
/**
 * Notify upstream workspaces that a downstream destroy has completed.
 * When all of an upstream's downstreams are destroyed, queue its destroy job.
 */
async function notifyDestroyComplete(deploymentId: string): Promise<void> {
  const deployment = await findDeploymentById(deploymentId)
  if (!deployment) return

  // For each upstream, check if all its downstreams are now destroyed
  for (const upstreamId of deployment.upstreamIds) {
    const downstreams = await findDownstreamDeployments(upstreamId)
    const allDestroyed = downstreams.every(d => d.status === "destroyed")
    
    if (allDestroyed) {
      const upstream = await findDeploymentById(upstreamId)
      // Only queue if upstream is pending (waiting for destroy)
      if (upstream?.status === "pending") {
        await createIacJob({
          deploymentId: upstreamId,
          jobType: "destroy",
        })
        logger.info("Queued destroy job for upstream after downstreams completed", {
          upstreamId,
          workspacePath: upstream.workspacePath,
        })
      }
    }
  }
}
```

Modify `executeJob` to call this after successful destroy:

```typescript
if (result.success) {
  await completeJob(jobId, { ... })
  
  if (job.jobType === "destroy") {
    await notifyDestroyComplete(preview.id)
  } else {
    await notifyDownstreams(preview.id, job.jobType)
  }
}
```

### 2e. Add PR Comment Updates from DB State

Add function to render and update PR comments from database state:

```typescript
/**
 * Update the PR comment by querying all sibling deployments from DB.
 * This is stateless - can be called from any process.
 */
async function updatePrCommentFromDb(deployment: WorkspaceDeployment): Promise<void> {
  // Only for PR environments with installation
  if (!deployment.prNumber || !deployment.installationId) return

  const org = await findOrgById(deployment.orgId)
  if (!org) return

  // Find all sibling deployments in this PR environment
  const siblings = await findDeploymentsByEnvironment(
    deployment.orgId,
    deployment.repo,
    deployment.environmentName,
  )

  // Query latest run for each to get plan summaries, outputs, etc.
  const workspaceStates = await Promise.all(
    siblings.map(async (d) => {
      const latestRun = await findLatestRun(d.id)
      return {
        workspacePath: d.workspacePath,
        status: d.status,
        planSummary: latestRun?.planSummary,
        outputs: latestRun?.outputs,
      }
    })
  )

  // Render comment body
  const body = renderCommentFromStates(deployment.headSha, workspaceStates)

  // Parse owner/repo
  const repoParts = deployment.repo.split("/")
  const owner = repoParts.length > 1 ? repoParts[0] : org.slug
  const repo = repoParts.length > 1 ? repoParts[1] : deployment.repo

  // Upsert to GitHub
  await upsertPrComment(
    deployment.installationId,
    owner,
    repo,
    deployment.prNumber,
    body,
    PR_COMMENT_MARKER,
  )
}
```

Call after any job completion that affects PR deployments.

---

## Phase 3: Cleanup Dead Code

**File:** `apps/control-plane/src/lib/webhook-handler.ts`

### 3a. Remove `executeRun` Function

Delete lines 1103-1339 (~240 lines). This function is only used for inline
destroy and will be dead code after Phase 1.

### 3b. Remove Unused Imports

After removing `executeRun`, these imports may become unused:

```typescript
// Potentially removable (verify with linter):
import { LocalRunner } from "./local-runner.ts"
import { getRunDurationHistogram, getRunResultCounter, getRunQueueTimeHistogram } from "./telemetry.ts"
// ... check for others
```

### 3c. Simplify `createHandler` Signature

The `runner` parameter is no longer used. Options:

1. **Remove entirely** - breaking change for tests, but cleaner
2. **Mark as deprecated** - `_runner?: Runner` with JSDoc deprecation
3. **Update tests** - remove runner injection from test setup

Recommendation: Option 1 (remove) with test updates in Phase 4.

---

## Phase 4: Test Updates

**File:** `apps/control-plane/src/lib/webhook-handler.test.ts`

### 4a. Update Destroy Tests

Change tests to verify job queueing instead of inline execution:

```typescript
test("PR closed without merge: queues destroy jobs", async () => {
  await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
  await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: false }))

  // Preview status is pending (waiting for destroy job to execute)
  const pvs = await db.select().from(previews)
  expect(pvs).toHaveLength(1)
  expect(pvs[0].status).toBe("pending")

  // Destroy job is queued
  const jobs = await getAllJobs()
  const destroyJobs = jobs.filter((j) => j.jobType === "destroy")
  expect(destroyJobs).toHaveLength(1)
  expect(destroyJobs[0].deploymentId).toBe(pvs[0].id)

  // Runner is NOT called (execution happens via IaC engine)
  expect(runner.calls).toHaveLength(0)
})

test("PR merged: queues destroy jobs (production apply is via push event)", async () => {
  await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
  await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: true }))

  // Destroy job queued for preview cleanup
  const jobs = await getAllJobs()
  const destroyJobs = jobs.filter((j) => j.jobType === "destroy")
  expect(destroyJobs).toHaveLength(1)

  // No inline execution
  expect(runner.calls).toHaveLength(0)
})
```

### 4b. Add Multi-Workspace Destroy Order Test

```typescript
test("multi-workspace destroy: queues leaf workspaces first", async () => {
  // Config where infra/monitoring depends on infra
  const config: YaffleTomlConfig = {
    version: 1,
    environments: [{ name: "main" }],
    workspaces: [
      { path: "infra", environments: "*" },
      { path: "infra/monitoring", environments: "*" },
    ],
    triggers: {
      github: {
        push: [{ branch: "main", environment: "main" }],
        pull_request: [{ branch_patterns: ["*"], exclude_branch_patterns: [] }],
      },
    },
    approvals: [],
  }
  
  // Mock dependency: monitoring depends on infra
  // (This requires setup in the dependency scanner mock)
  
  handler = createHandler(runner, { configLoader: fakeConfigLoader(config) })

  await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
  
  // Set up dependency relationship (infra/monitoring depends on infra)
  const pvs = await db.select().from(previews)
  const infraPreview = pvs.find(p => p.workspacePath === "infra")!
  const monitoringPreview = pvs.find(p => p.workspacePath === "infra/monitoring")!
  await setDeploymentUpstreams(monitoringPreview.id, [infraPreview.id])

  await handler.handleWebhookEvent(makePrContext({ action: "closed" }))

  // Only leaf workspace (infra/monitoring) gets destroy job queued initially
  const destroyJobs = (await getAllJobs()).filter((j) => j.jobType === "destroy")
  expect(destroyJobs).toHaveLength(1)
  expect(destroyJobs[0].deploymentId).toBe(monitoringPreview.id)

  // infra destroy will be queued by IaC engine after monitoring completes
})
```

### 4c. Remove FakeRunner from Tests (Optional)

If `runner` parameter is removed from `createHandler`, update test setup:

```typescript
// Before:
runner = new FakeRunner()
handler = createHandler(runner, { configLoader: fakeConfigLoader(DEFAULT_CONFIG) })

// After:
handler = createHandler({ configLoader: fakeConfigLoader(DEFAULT_CONFIG) })
```

---

## Expected Outcomes

### Lines of Code

| File | Before | After | Change |
|------|--------|-------|--------|
| webhook-handler.ts | ~1400 | ~1100 | -300 |
| iac-engine.ts | ~520 | ~620 | +100 |

### Architecture

After this migration:
- **webhook-handler.ts** becomes a pure orchestrator (routes events, queues jobs)
- **iac-engine.ts** handles all terraform execution
- Clean separation enables SRP refactoring of webhook-handler

### Future Work

With destroy job-based, the webhook-handler can be further refactored:
- Extract `deployment-orchestrator.ts` for DAG setup logic
- Extract `apply-service.ts` for `triggerApply` and `rerunPreview`
- Reduce webhook-handler to ~200-300 lines of pure dispatch

---

## Implementation Order

1. **Phase 2 first** - Add IaC engine capabilities (low risk, additive)
2. **Phase 1 second** - Switch webhook-handler to job-based (swap behavior)
3. **Phase 4 third** - Update tests (verify behavior)
4. **Phase 3 last** - Cleanup dead code (safe after tests pass)

This order minimizes risk by ensuring the IaC engine can handle destroy jobs
before we start sending them.

---

## Rollback Plan

If issues arise after deployment:

1. **Feature flag** (optional): Add `YAFFLE_INLINE_DESTROY=true` env var to
   temporarily fall back to inline execution
2. **Quick revert**: The phases are isolated - revert Phase 1 changes to restore
   inline destroy while keeping Phase 2 IaC engine enhancements
