# Observability Guide

> **Dashboard**: A pre-configured dashboard JSON is available at
> [`docs/axiom-dashboard.json`](./axiom-dashboard.json). Import it via the
> Axiom API or use the queries below to build your own.

---

# Observability Guide

Yaffle uses OpenTelemetry to send traces, metrics, and logs to Axiom. This guide
covers how to query and visualize webhook-to-job flows.

## Key Concepts

### Correlation

All logs emitted during webhook processing and job execution include trace context.
You can correlate events using:

- **`trace_id`** - Links all events from a single webhook through job completion
- **`attributes.webhook.delivery_id`** - GitHub's unique webhook delivery ID
- **`attributes.job.id`** - Yaffle job UUID
- **`attributes.deployment.id`** - Yaffle deployment UUID
- **`attributes.git.commit.sha`** - Git commit SHA that triggered the flow

### Job Lifecycle Events

Jobs emit structured lifecycle logs at each state transition:

| Event | Description | Key Attributes |
|-------|-------------|----------------|
| `job.created` | Job queued | `job.id`, `job.type`, `deployment.id` |
| `job.claimed` | Worker claimed job (queued→running) | `job.id`, `worker.id`, `duration.queue_wait_ms` |
| `job.completed` | Job succeeded (running→completed) | `job.id`, `duration.run_ms` |
| `job.failed` | Job failed (running→failed) | `job.id`, `duration.run_ms`, `error.message` |
| `job.stale_timeout` | Worker stopped heartbeating | `job.id`, `duration.stale_ms` |
| `job.cancelled` | Job cancelled (e.g., PR closed) | `job.id`, `deployment.id` |

## APL Query Templates

### 1. Trace a Webhook by Delivery ID

Find all events related to a specific GitHub webhook delivery:

```apl
['yaffle']
| where ['attributes.webhook.delivery_id'] == "YOUR_DELIVERY_ID"
    or body contains "YOUR_DELIVERY_ID"
| order by _time asc
| project _time, body, trace_id, ['attributes.job.id'], ['attributes.deployment.id']
```

### 2. Trace All Activity for a SHA

Find all events triggered by a specific commit:

```apl
['yaffle']
| where ['attributes.git.commit.sha'] == "YOUR_SHA"
    or ['attributes.webhook.after'] == "YOUR_SHA"
    or ['attributes.yaffle.head_sha'] == "YOUR_SHA"
| order by _time asc
| project _time, body, ['attributes.job.id'], ['attributes.deployment.id'], ['attributes.job.status']
```

### 3. Job Lifecycle Timeline

View the complete lifecycle of a specific job:

```apl
['yaffle']
| where ['attributes.job.id'] == "YOUR_JOB_ID"
    or body contains "YOUR_JOB_ID"
| order by _time asc
| project _time, body, ['attributes.job.status'], ['attributes.worker.id'], ['attributes.duration.queue_wait_ms'], ['attributes.duration.run_ms']
```

### 4. Queue Wait Time Distribution (Last 24h)

Analyze how long jobs wait in queue before being claimed:

```apl
['yaffle']
| where body == "job.claimed"
    and isnotempty(['attributes.duration.queue_wait_ms'])
| summarize
    p50 = percentile(['attributes.duration.queue_wait_ms'], 50),
    p90 = percentile(['attributes.duration.queue_wait_ms'], 90),
    p99 = percentile(['attributes.duration.queue_wait_ms'], 99),
    max = max(['attributes.duration.queue_wait_ms'])
  by bin(_time, 1h)
| order by _time desc
```

### 5. Run Duration Distribution by Job Type

Analyze execution time by job type:

```apl
['yaffle']
| where body == "job.completed" or body == "job.failed"
| where isnotempty(['attributes.duration.run_ms'])
| summarize
    p50 = percentile(['attributes.duration.run_ms'], 50),
    p90 = percentile(['attributes.duration.run_ms'], 90),
    p99 = percentile(['attributes.duration.run_ms'], 99),
    count = count()
  by ['attributes.job.type']
```

### 6. Job Success Rate Over Time

Track job success/failure trends:

```apl
['yaffle']
| where body in ("job.completed", "job.failed")
| summarize
    total = count(),
    completed = countif(body == "job.completed"),
    failed = countif(body == "job.failed")
  by bin(_time, 5m)
| extend success_rate = round(todouble(completed) / todouble(total) * 100, 2)
| order by _time desc
```

### 7. Failed Jobs with Errors

List recent job failures with error messages:

```apl
['yaffle']
| where body == "job.failed" or body == "job.stale_timeout"
| order by _time desc
| take 50
| project
    _time,
    ['attributes.job.id'],
    ['attributes.job.type'],
    ['attributes.deployment.id'],
    ['attributes.error.message'],
    ['attributes.duration.run_ms']
```

### 8. Webhook Volume by Event Type

Monitor incoming webhook traffic:

```apl
['yaffle']
| where body startswith "webhook received"
| summarize count() by ['attributes.webhook.event'], bin(_time, 5m)
| order by _time desc
```

### 9. Jobs Blocked by Concurrency Limits

Find when jobs are waiting due to scheduler limits:

```apl
['yaffle']
| where body contains "blocked by"
| summarize
    blocked_by_global = sumif(['attributes.blocked'], body contains "global"),
    blocked_by_group = sumif(['attributes.blocked'], body contains "per-group")
  by bin(_time, 5m)
| order by _time desc
```

### 10. End-to-End Latency (Webhook to Job Completion)

Calculate total time from webhook receipt to job completion:

```apl
['yaffle']
| where body == "job.completed" or body == "job.claimed"
| summarize
    claimed_at = minif(_time, body == "job.claimed"),
    completed_at = maxif(_time, body == "job.completed"),
    queue_wait_ms = avgif(['attributes.duration.queue_wait_ms'], body == "job.claimed"),
    run_ms = avgif(['attributes.duration.run_ms'], body == "job.completed")
  by ['attributes.job.id']
| where isnotempty(completed_at) and isnotempty(claimed_at)
| extend total_ms = (completed_at - claimed_at) / 1ms
| project ['attributes.job.id'], queue_wait_ms, run_ms, total_ms
| order by total_ms desc
| take 20
```

## Metrics Reference

The following OTel metrics are available:

### Job Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `yaffle.job.queue_wait` | Histogram | `job_type` | Time from creation to claim (ms) |
| `yaffle.job.run_duration` | Histogram | `job_type`, `status` | Time from start to completion (ms) |
| `yaffle.job.heartbeats` | Counter | - | Successful heartbeat count |
| `yaffle.job.state_transitions` | Counter | `from_state`, `to_state`, `job_type` | State change count |

### Scheduler Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `yaffle.scheduler.jobs.claimed` | Counter | - | Jobs dispatched to workers |
| `yaffle.scheduler.jobs.blocked` | Counter | `reason` | Jobs blocked by limits |
| `yaffle.scheduler.jobs.active` | Gauge | - | Currently running jobs |
| `yaffle.scheduler.jobs.queued` | Gauge | - | Jobs waiting in queue |
| `yaffle.scheduler.poll.duration` | Histogram | - | Scheduler poll cycle time (ms) |

### Webhook Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `yaffle.webhook.received` | Counter | `event` | Webhooks received by type |

## Troubleshooting Scenarios

### Job Stuck in Queue

1. Check if concurrency limits are blocking:
   ```apl
   ['yaffle']
   | where body contains "blocked by"
   | order by _time desc
   | take 10
   ```

2. Check active job count:
   ```apl
   ['yaffle']
   | where body == "job.claimed" and _time > ago(1h)
   | summarize running = dcount(['attributes.job.id'])
   ```

### Job Failed Without Clear Error

1. Find the job's full timeline:
   ```apl
   ['yaffle']
   | where ['attributes.job.id'] == "JOB_ID"
   | order by _time asc
   ```

2. Look for stale timeout:
   ```apl
   ['yaffle']
   | where body == "job.stale_timeout" and ['attributes.job.id'] == "JOB_ID"
   ```

### Webhook Not Processing

1. Verify webhook was received:
   ```apl
   ['yaffle']
   | where ['attributes.webhook.delivery_id'] == "DELIVERY_ID"
   ```

2. Check for duplicate detection:
   ```apl
   ['yaffle']
   | where body contains "duplicate" and body contains "DELIVERY_ID"
   ```

### High Queue Wait Times

1. Check queue depth over time:
   ```apl
   ['yaffle']
   | where name == "yaffle.scheduler.jobs.queued"
   | summarize avg(value) by bin(_time, 5m)
   ```

2. Check for blocked jobs:
   ```apl
   ['yaffle']
   | where body contains "blocked by global"
   | summarize sum(['attributes.blocked']) by bin(_time, 5m)
   ```
