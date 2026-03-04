# Runs Page Refactor Plan

**Linear:** [YAF-22](https://linear.app/yaffledev/issue/YAF-22)

## Overview

Refactor the runs/preview viewing experience with:
- Human-readable URLs (`/:org/:repo/pr/:prNumber`)
- Grouped workspace sidebar view
- Terminal-style logs with ANSI color support via xterm.js
- Contextual tabs (Plan/Apply/Outputs)
- Event-driven SSE (real-time updates instead of 5s polling)

## Decisions

- **Shared component**: PR and env pages share a `PreviewGroupPage.svelte` component
- **GitHub link**: Single "GitHub" link in header (goes to PR page or repo page as appropriate)
- **Approval UI**: Deferred to future work
- **Check run links**: Keep in new UI

## Phases

| Phase | Description | Effort |
|-------|-------------|--------|
| 1 | Event-driven SSE infrastructure | Small |
| 2 | New API endpoints for composite keys | Small |
| 3 | Enable ANSI colors in runner | Trivial |
| 4 | Terminal component with xterm.js | Medium |
| 5 | New grouped preview page | Medium |
| 6 | Long-lived environment page | Small |
| 7 | Cleanup old routes | Trivial |

---

## Phase 1: Event-Driven SSE Infrastructure

Replace 5-second polling with in-process EventEmitter. This is the simplest approach for single-instance deployment; can migrate to Postgres LISTEN/NOTIFY later for multi-instance.

### Create: `apps/control-plane/src/lib/events.ts`

```typescript
import { EventEmitter } from "node:events"

type RunEvent = { runId: string; previewId: string }
type PreviewEvent = { previewId: string }

class YaffleEvents extends EventEmitter {
  emitRunUpdate(runId: string, previewId: string) {
    this.emit("run:update", { runId, previewId })
  }
  emitPreviewUpdate(previewId: string) {
    this.emit("preview:update", { previewId })
  }
}

export const events = new YaffleEvents()
```

### Modify: `apps/control-plane/src/db/queries/tf-runs.ts`

- Import `events` from `../lib/events.ts`
- In `updateRunStatus`: emit `run:update` after DB write
- In `appendRunLog`: emit `run:update` after DB write (for log streaming)

### Modify: `apps/control-plane/src/db/queries/previews.ts`

- Import `events` from `../../lib/events.ts`
- In `updatePreviewStatus`: emit `preview:update` after DB write

### Modify: `apps/control-plane/src/routes/runs.ts`

- Replace polling interval with event listener
- On `run:update` where `runId` matches, call `sendSnapshot()`
- Keep `stream.onAbort()` to remove listener

### Modify: `apps/control-plane/src/routes/previews.ts`

- Replace polling intervals with event listeners
- On `preview:update` where `previewId` matches, call `sendSnapshot()`

---

## Phase 2: New API Endpoints

### Modify: `apps/control-plane/src/db/queries/previews.ts`

Add new query functions:

```typescript
// Fetch all previews for a PR (all workspaces)
export async function findPreviewsByPr(
  orgId: string,
  repo: string,
  prNumber: number
): Promise<Preview[]>

// Fetch previews for a long-lived environment (branch, prNumber=0)
export async function findPreviewsByEnv(
  orgId: string,
  repo: string,
  branch: string
): Promise<Preview[]>
```

### Modify: `apps/control-plane/src/routes/previews.ts`

Add new endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/orgs/:org/repos/:repo/pr/:prNumber` | Fetch all previews for PR |
| GET | `/api/orgs/:org/repos/:repo/pr/:prNumber/stream` | SSE stream for PR |
| GET | `/api/orgs/:org/repos/:repo/env/:branch` | Fetch env previews |
| GET | `/api/orgs/:org/repos/:repo/env/:branch/stream` | SSE stream for env |

### Modify: `apps/web/src/lib/api.ts`

Add client functions:

```typescript
export async function getPreviewsByPr(
  org: string, 
  repo: string, 
  prNumber: number
): Promise<ApiResponse<Preview[]>>

export async function getPreviewsByEnv(
  org: string, 
  repo: string, 
  branch: string
): Promise<ApiResponse<Preview[]>>
```

---

## Phase 3: Enable ANSI Colors

### Modify: `apps/control-plane/src/lib/terraform.ts`

Remove `-no-color` flag from these commands (preserving it for JSON outputs):

| Line | Function | Action |
|------|----------|--------|
| 99 | `tfInit` | Remove `-no-color` |
| 122 | `tfPlan` | Remove `-no-color` |
| 138 | `tfShow` | **Keep** `-no-color` (JSON output) |
| 169 | `tfApply` | Remove `-no-color` |
| 180 | `tfOutput` | **Keep** `-no-color` (JSON output) |
| 201 | `tfDestroy` | Remove `-no-color` |

The `sanitizeOutput` function already preserves ANSI escape codes (it only does text replacement for branding).

---

## Phase 4: Terminal Component

### Install dependencies

```bash
cd apps/web && bun add xterm @xterm/addon-fit @xterm/addon-web-links
```

### Create: `apps/web/src/lib/components/Terminal.svelte`

Features:
- xterm.js instance with Yaffle theme colors
- `output` prop that writes to terminal
- `streaming` prop for buffering behavior (batch writes every 50-100ms)
- FitAddon for responsive sizing
- WebLinksAddon for clickable URLs
- Auto-scroll with toggle

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte"
  import { Terminal } from "xterm"
  import { FitAddon } from "@xterm/addon-fit"
  import { WebLinksAddon } from "@xterm/addon-web-links"
  import "xterm/css/xterm.css"
  
  let { output = "", streaming = false } = $props()
  
  let container: HTMLDivElement
  let term: Terminal
  let fitAddon: FitAddon
  
  onMount(() => {
    term = new Terminal({
      theme: {
        background: "#1a1a1a",
        foreground: "#e0e0e0",
        // ... match yaffle theme colors
      },
      fontFamily: "ui-monospace, monospace",
      fontSize: 13,
      scrollback: 10000,
      convertEol: true,
    })
    
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    
    term.open(container)
    fitAddon.fit()
  })
  
  $effect(() => {
    if (term && output) {
      term.clear()
      term.write(output)
    }
  })
  
  onDestroy(() => term?.dispose())
</script>

<div bind:this={container} class="h-full w-full" />
```

### Create: `apps/web/src/lib/components/PlanSummary.svelte`

Features:
- Resource changes table (from `planJson.resource_changes`)
- Action icons (+, -, ~, ↻)
- Grouped by action type
- Collapsible sections

### Create: `apps/web/src/lib/components/OutputsView.svelte`

Features:
- Key/value table of terraform outputs
- Sensitive value masking with reveal toggle
- JSON toggle for raw view
- Copy button per value

---

## Phase 5: Grouped Preview Page

### Create: `apps/web/src/lib/components/PreviewGroupPage.svelte`

Shared component used by both PR and env pages. Props:
- `type: "pr" | "env"` - determines header display
- `org: string`
- `repo: string`  
- `identifier: number | string` - PR number or branch name
- `workspaces: Preview[]`
- `githubUrl: string` - link to PR or repo

### Create: `apps/web/src/routes/[org]/[repo]/pr/[prNumber]/+page.svelte`

Thin wrapper that fetches data and renders `PreviewGroupPage` with `type="pr"`.

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ org/repo                                    [GitHub] PR #123    │
│ branch: feat/something @ abc1234                                │
├────────────┬────────────────────────────────────────────────────┤
│ Workspaces │                                                    │
│            │  apps/control-plane/infra                          │
│ ● control- │  ───────────────────────────────────────────────── │
│   plane/   │                                                    │
│   infra    │  [Plan ✓] [Apply ⏳] [Outputs]                     │
│   ✓✓       │                                                    │
│            │  ┌──────────────────────────────────────────────┐  │
│ ○ infra/   │  │                                              │  │
│   monitor  │  │  <Terminal output>                           │  │
│   ✓✓       │  │                                              │  │
│            │  │                                              │  │
│            │  └──────────────────────────────────────────────┘  │
└────────────┴────────────────────────────────────────────────────┘
```

### State

- `workspaces: Preview[]` - all workspaces for this PR
- `selectedWs: string` - workspace path (from `?ws=` query param or first)
- `activeTab: "plan" | "apply" | "outputs"` - current tab
- `runs: Map<string, Run[]>` - runs by preview ID

### Data fetching

- Initial: `GET /api/orgs/:org/repos/:repo/pr/:prNumber`
- SSE: Connect to `/api/orgs/:org/repos/:repo/pr/:prNumber/stream`
- On preview update, refetch runs for that preview

### Create: `apps/web/src/lib/components/WorkspaceSidebar.svelte`

- List of workspace paths
- Status indicators (plan ✓/⏳/✗, apply ✓/⏳/✗)
- Click to select (updates `?ws=` query param)

### Tab logic

```typescript
const latestPlan = $derived(runs.find(r => r.runType === "plan"))
const latestApply = $derived(runs.find(r => r.runType === "apply"))
const hasOutputs = $derived(latestApply?.status === "success" && latestApply.outputs)

const tabs = $derived([
  latestPlan && { id: "plan", label: "Plan", status: latestPlan.status },
  latestApply && { id: "apply", label: "Apply", status: latestApply.status },
  hasOutputs && { id: "outputs", label: "Outputs" },
].filter(Boolean))
```

---

## Phase 6: Long-Lived Environment Page

### Create: `apps/web/src/routes/[org]/[repo]/[envName]/+page.svelte`

Thin wrapper that fetches data and renders `PreviewGroupPage` with `type="env"`.

- Fetches via `GET /api/orgs/:org/repos/:repo/env/:branch`
- Header shows branch name (e.g., "main") instead of PR number
- GitHub link goes to repo page instead of PR

---

## Phase 7: Cleanup

### Delete

- `apps/web/src/routes/previews/[id]/+page.svelte`
- `apps/web/src/routes/runs/[id]/+page.svelte`

### Modify: `apps/web/src/routes/[org]/+page.svelte`

- Update preview links from `/previews/:id` to `/:org/:repo/pr/:prNumber?ws=:path`
- Update environment links to `/:org/:repo/:branch`

### Modify: `apps/control-plane/src/routes/previews.ts`

Remove old endpoints:
- `GET /api/previews/:id`
- `GET /api/previews/:id/stream`
- `GET /api/previews/:id/runs`
- `GET /api/previews/:id/outputs`

### Modify: `apps/control-plane/src/routes/runs.ts`

Remove old endpoints:
- `GET /api/runs/:id`
- `GET /api/runs/:id/stream`
- `GET /api/runs/:id/plan`
- `GET /api/runs/:id/output`

---

## File Summary

| Action | File |
|--------|------|
| **Create** | `apps/control-plane/src/lib/events.ts` |
| **Create** | `apps/web/src/lib/components/Terminal.svelte` |
| **Create** | `apps/web/src/lib/components/PlanSummary.svelte` |
| **Create** | `apps/web/src/lib/components/OutputsView.svelte` |
| **Create** | `apps/web/src/lib/components/WorkspaceSidebar.svelte` |
| **Create** | `apps/web/src/lib/components/PreviewGroupPage.svelte` |
| **Create** | `apps/web/src/routes/[org]/[repo]/pr/[prNumber]/+page.svelte` |
| **Create** | `apps/web/src/routes/[org]/[repo]/[envName]/+page.svelte` |
| **Modify** | `apps/control-plane/src/db/queries/tf-runs.ts` |
| **Modify** | `apps/control-plane/src/db/queries/previews.ts` |
| **Modify** | `apps/control-plane/src/routes/previews.ts` |
| **Modify** | `apps/control-plane/src/routes/runs.ts` |
| **Modify** | `apps/control-plane/src/lib/terraform.ts` |
| **Modify** | `apps/web/src/lib/api.ts` |
| **Modify** | `apps/web/src/routes/[org]/+page.svelte` |
| **Delete** | `apps/web/src/routes/previews/[id]/+page.svelte` |
| **Delete** | `apps/web/src/routes/runs/[id]/+page.svelte` |

---

## Future Considerations

### Multi-Instance SSE (when needed)

Replace EventEmitter with Postgres LISTEN/NOTIFY:

```typescript
// lib/events.ts (future)
import postgres from "postgres"

const listener = postgres(process.env.DATABASE_URL!)
const localEmitter = new EventEmitter()

// Bridge PG notifications to local emitter
await listener.listen("yaffle_events", (payload) => {
  const event = JSON.parse(payload)
  localEmitter.emit(event.type, event.data)
})

// Export same interface
export const runEvents = {
  emit: async (type: string, data: unknown) => {
    await db.execute(sql`NOTIFY yaffle_events, ${JSON.stringify({ type, data })}`)
  },
  on: localEmitter.on.bind(localEmitter),
}
```

This keeps the same API, making the transition seamless.
