/**
 * PR comment manager. Maintains a single consolidated PR comment that
 * tracks all workspaces through their plan -> apply -> ready lifecycle.
 *
 * Each PR gets ONE comment (identified by `<!-- yaffle:pr -->` marker).
 * The comment is re-rendered on each state change via a serialized
 * write queue to prevent concurrent GitHub API race conditions.
 *
 * Comment layout:
 *
 *   <!-- yaffle:pr -->
 *   ### Yaffle
 *
 *   | Workspace | Status | Logs |
 *   |-----------|--------|------|
 *   | `infra` | ✅ Preview ready | [Plan](url) · [Apply](url) |
 *   | `infra/monitoring` | ⏳ Applying... | [Plan](url) |
 *
 *   <details>
 *   <summary><code>infra</code> outputs</summary>
 *
 *   | Output | Value |
 *   |--------|-------|
 *   | `cluster_arn` | `arn:...` |
 *   </details>
 */

import { upsertPrComment } from "./github.ts"
import { logger } from "./telemetry.ts"
import { WriteQueue } from "./write-queue.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Check run reference for linking in the comment. */
export interface CheckRunRef {
  id: number
  url: string
}

/** The current phase of a workspace. */
export type CommentPhase =
  | "planning"
  | "plan_success"
  | "plan_failed"
  | "applying"
  | "ready"
  | "apply_failed"
  | "destroying"
  | "destroyed"

/** Per-workspace state tracked by the manager. */
export interface WorkspaceState {
  phase: CommentPhase
  planSummary?: string
  outputs?: Record<string, unknown>
  planCheckRun?: CheckRunRef
  applyCheckRun?: CheckRunRef
  errorMessage?: string
}

/** GitHub context needed to post comments. */
export interface PrCommentContext {
  installationId: number
  owner: string
  repo: string
  prNumber: number
  headSha: string
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

/** The single HTML marker for the consolidated Yaffle PR comment. */
export const PR_COMMENT_MARKER = "<!-- yaffle:pr -->"

// ---------------------------------------------------------------------------
// PrCommentManager
// ---------------------------------------------------------------------------

/**
 * Manages a single consolidated PR comment across all workspaces.
 *
 * Create one per PR event (opened/synchronize/closed). Call `update()`
 * from each workspace at each phase change. The manager serializes
 * all GitHub API writes through a queue.
 *
 * For testing, inject a custom `writer` function instead of the real
 * GitHub API.
 */
export class PrCommentManager {
  private ctx: PrCommentContext
  private workspaces = new Map<string, WorkspaceState>()
  private queue: WriteQueue
  private writer: (ctx: PrCommentContext, body: string, marker: string) => Promise<void>

  constructor(
    ctx: PrCommentContext,
    opts?: {
      writer?: (ctx: PrCommentContext, body: string, marker: string) => Promise<void>
    },
  ) {
    this.ctx = ctx
    this.queue = new WriteQueue()
    this.writer = opts?.writer ?? defaultWriter
  }

  /**
   * Update a workspace's state and re-render + upsert the comment.
   * Safe to call concurrently -- writes are serialized.
   */
  update(workspacePath: string, state: WorkspaceState): Promise<void> {
    this.workspaces.set(workspacePath, state)

    return this.queue.enqueue(async () => {
      const body = renderComment(this.ctx.headSha, this.workspaces)

      try {
        await this.writer(this.ctx, body, PR_COMMENT_MARKER)
        logger.info("updated PR comment", {
          "yaffle.owner": this.ctx.owner,
          "yaffle.repo": this.ctx.repo,
          "yaffle.pr_number": this.ctx.prNumber,
          "yaffle.workspace_path": workspacePath,
          "yaffle.comment_phase": state.phase,
        })
      } catch (err) {
        logger.warn("failed to update PR comment", {
          "yaffle.owner": this.ctx.owner,
          "yaffle.repo": this.ctx.repo,
          "yaffle.pr_number": this.ctx.prNumber,
          "yaffle.workspace_path": workspacePath,
          "yaffle.comment_phase": state.phase,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /** Wait for all queued writes to complete. */
  async flush(): Promise<void> {
    await this.queue.flush()
  }

  /** Get current workspace states. For testing. */
  getStates(): ReadonlyMap<string, WorkspaceState> {
    return this.workspaces
  }
}

/**
 * No-op manager returned when there's no installation (tests, push events).
 * All methods are safe to call but do nothing.
 */
export class NoopCommentManager {
  update(_workspacePath: string, _state: WorkspaceState): Promise<void> {
    return Promise.resolve()
  }

  async flush(): Promise<void> {}
}

export type CommentManager = PrCommentManager | NoopCommentManager

/**
 * Create the appropriate comment manager for a context.
 * Returns a PrCommentManager for PR events with an installation,
 * NoopCommentManager otherwise.
 */
export function createCommentManager(
  ctx: {
    kind: string
    installationId?: number
    owner: string
    repo: string
    headSha: string
    prNumber?: number
  },
  opts?: { writer?: (ctx: PrCommentContext, body: string, marker: string) => Promise<void> },
): CommentManager {
  if (ctx.kind === "pull_request" && ctx.installationId && ctx.prNumber != null) {
    return new PrCommentManager(
      {
        installationId: ctx.installationId,
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        headSha: ctx.headSha,
      },
      opts,
    )
  }
  return new NoopCommentManager()
}

// ---------------------------------------------------------------------------
// Default writer (calls GitHub API)
// ---------------------------------------------------------------------------

async function defaultWriter(ctx: PrCommentContext, body: string, marker: string): Promise<void> {
  await upsertPrComment(ctx.installationId, ctx.owner, ctx.repo, ctx.prNumber, body, marker)
}

// ---------------------------------------------------------------------------
// Comment rendering
// ---------------------------------------------------------------------------

/**
 * Build the check run URL from owner/repo/id.
 */
export function checkRunUrl(owner: string, repo: string, checkRunId: number): string {
  return `https://github.com/${owner}/${repo}/runs/${checkRunId}`
}

/**
 * Render the full consolidated PR comment from all workspace states.
 * Exported for testing.
 */
export function renderComment(
  headSha: string,
  workspaces: ReadonlyMap<string, WorkspaceState>,
): string {
  const shortSha = headSha.slice(0, 7)
  const lines: string[] = [PR_COMMENT_MARKER, `### Yaffle \`${shortSha}\``, ""]

  // Status table
  lines.push("| Workspace | Status | Logs |")
  lines.push("|-----------|--------|------|")

  for (const [path, state] of workspaces) {
    const displayPath = path === "." ? "root" : path
    const { icon, label } = phaseDisplay(state)
    const logs = formatLogsCell(state)
    lines.push(`| \`${displayPath}\` | ${icon} ${label} | ${logs} |`)
  }

  // Outputs sections (collapsible, one per workspace that has outputs)
  const outputSections: string[] = []
  for (const [path, state] of workspaces) {
    if (state.phase !== "ready" || !state.outputs) continue
    const entries = Object.entries(state.outputs)
    if (entries.length === 0) continue

    const displayPath = path === "." ? "root" : path
    const section = renderOutputsSection(displayPath, state.outputs)
    if (section) outputSections.push(section)
  }

  if (outputSections.length > 0) {
    lines.push("")
    lines.push(outputSections.join("\n\n"))
  }

  return lines.join("\n")
}

interface RunGroupCommentPlan {
  status: string
  planSummary: string | null
}

export interface RunGroupCommentWorkspace {
  path: string
  preview: RunGroupCommentPlan
  mergeImpact: RunGroupCommentPlan | null
}

export function renderRunGroupComment(values: {
  headSha: string
  targetEnvironment: string | null
  detailsUrl: string
  workspaces: RunGroupCommentWorkspace[]
}): string {
  const lines = [
    PR_COMMENT_MARKER,
    `### Yaffle \`${values.headSha.slice(0, 7)}\``,
    "",
    "| Workspace | Preview | Merge impact |",
    "|-----------|---------|--------------|",
  ]
  for (const workspace of values.workspaces) {
    const previewSummary = workspace.preview.planSummary
      ? `${workspace.preview.status === "ready" ? "Ready" : workspace.preview.status} (${workspace.preview.planSummary})`
      : workspace.preview.status
    const mergeSummary = workspace.mergeImpact
      ? `${values.targetEnvironment ?? "target"}: ${workspace.mergeImpact.planSummary ?? workspace.mergeImpact.status}`
      : "Not available"
    lines.push(`| \`${workspace.path}\` | ${previewSummary} | ${mergeSummary} |`)
  }
  lines.push("", `[View run details](${values.detailsUrl})`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function phaseDisplay(state: WorkspaceState): { icon: string; label: string } {
  switch (state.phase) {
    case "planning":
      return { icon: "\u23f3", label: "Planning..." }
    case "plan_success":
      return { icon: "\u2705", label: `Plan: ${state.planSummary ?? "complete"}` }
    case "plan_failed":
      return {
        icon: "\u274c",
        label: `Plan failed${state.errorMessage ? `: ${state.errorMessage}` : ""}`,
      }
    case "applying":
      return { icon: "\u23f3", label: `Applying (${state.planSummary ?? "..."})` }
    case "ready":
      return { icon: "\u2705", label: "Preview ready" }
    case "apply_failed":
      return {
        icon: "\u274c",
        label: `Apply failed${state.errorMessage ? `: ${state.errorMessage}` : ""}`,
      }
    case "destroying":
      return { icon: "\ud83d\uddd1\ufe0f", label: "Destroying..." }
    case "destroyed":
      return { icon: "\ud83d\uddd1\ufe0f", label: "Destroyed" }
  }
}

function formatLogsCell(state: WorkspaceState): string {
  const links: string[] = []
  if (state.planCheckRun) {
    links.push(`[Plan](${state.planCheckRun.url})`)
  }
  if (state.applyCheckRun) {
    links.push(`[Apply](${state.applyCheckRun.url})`)
  }
  return links.join(" \u00b7 ")
}

function renderOutputsSection(
  displayPath: string,
  outputs: Record<string, unknown>,
): string | undefined {
  const entries = Object.entries(outputs)
  if (entries.length === 0) return undefined

  const lines: string[] = [
    `<details>`,
    `<summary><code>${displayPath}</code> outputs</summary>`,
    "",
    "| Output | Value |",
    "|--------|-------|",
  ]

  entries
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, raw]) => {
      const output = raw as TerraformOutput
      const value = output.sensitive ? "*(sensitive)*" : formatValue(output.value)
      lines.push(`| \`${name}\` | ${value} |`)
    })

  lines.push("")
  lines.push("</details>")

  return lines.join("\n")
}

/** Standard terraform output -json shape per key. */
interface TerraformOutput {
  value: unknown
  type?: unknown
  sensitive?: boolean
}

/**
 * Format a terraform output value for display in a markdown table cell.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ""

  if (typeof value === "string") return `\`${value}\``
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``

  const json = JSON.stringify(value)
  if (json.length <= 80) return `\`${json}\``

  return `<details><summary>complex value</summary>\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n</details>`
}
