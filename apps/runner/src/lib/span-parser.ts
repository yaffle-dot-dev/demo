/**
 * Resource Span Parser
 *
 * Parses terraform/tofu stdout in real-time to extract resource lifecycle events.
 * Handles partial lines (chunks may split mid-line) and emits ResourceSpanEvent
 * objects with wall-clock timestamps.
 *
 * Actual tofu output formats:
 *   aws_acm_certificate_validation.main: Creating...
 *   aws_cloudfront_distribution.main: Modifying... [id=EWVN2QG1SE6JF]
 *   aws_cloudfront_distribution.main: Still modifying... [id=EWVN2QG1SE6JF, 10s elapsed]
 *   aws_cloudfront_distribution.main: Still modifying... [id=EWVN2QG1SE6JF, 1m0s elapsed]
 *   aws_cloudfront_distribution.main: Modifications complete after 1m8s [id=EWVN2QG1SE6JF]
 *   aws_acm_certificate_validation.main: Creation complete after 0s [id=...]
 *   module.core.aws_eip.nat[1]: Refreshing state... [id=eipalloc-09855471d455edc7b]
 *   module.core.data.aws_availability_zones.available: Reading...
 *   aws_instance.bar: Destroying...
 *   aws_instance.bar: Destruction complete after 15s
 */

export interface ResourceSpanEvent {
  resourceAddress: string    // "module.vpc.aws_subnet.public[0]"
  resourceType: string       // "aws_subnet"
  action: "create" | "update" | "delete" | "refresh" | "read"
  event: "started" | "progress" | "complete" | "error"
  timestamp: number          // Date.now() wall-clock
  elapsedMs?: number         // parsed from "after Xs" on complete events
  message?: string           // error message or resource ID
}

type SpanEventCallback = (event: ResourceSpanEvent) => void

// Regex for resource addresses: optional module prefix, resource type, resource name, optional index
// Also handles data sources: module.core.data.aws_availability_zones.available
// Examples: aws_s3_bucket.foo, module.vpc.aws_subnet.public[0], module.a.module.b.aws_instance.bar["key"]
const RESOURCE_ADDR = String.raw`((?:module\.[^\s:]+\.)?(?:data\.)?[a-zA-Z][a-zA-Z0-9_]*\.[^\s:[\]]+(?:\[(?:\d+|"[^"]*")\])?)`

// Start events:
//   "Creating..."
//   "Modifying... [id=EWVN2QG1SE6JF]"
//   "Destroying..."
//   "Refreshing state... [id=...]"
//   "Reading..."
const START_RE = new RegExp(
  `^${RESOURCE_ADDR}: (Creating|Modifying|Destroying|Reading)\\.\\.\\.`,
)
const REFRESH_START_RE = new RegExp(
  `^${RESOURCE_ADDR}: Refreshing state\\.\\.\\.`,
)

// Progress events:
//   "Still modifying... [id=EWVN2QG1SE6JF, 10s elapsed]"
//   "Still modifying... [id=EWVN2QG1SE6JF, 1m0s elapsed]"
//   "Still creating... [30s elapsed]"
const PROGRESS_RE = new RegExp(
  `^${RESOURCE_ADDR}: Still (creating|modifying|destroying|refreshing|reading)\\.\\.\\.\\s*\\[(?:.*,\\s*)?((?:\\d+m)?\\d+)s elapsed\\]`,
)

// Complete events:
//   "Creation complete after 0s [id=...]"
//   "Modifications complete after 1m8s [id=EWVN2QG1SE6JF]"
//   "Destruction complete after 15s"
//   "Read complete after 0s [id=...]"
const COMPLETE_RE = new RegExp(
  `^${RESOURCE_ADDR}: (Creation|Modifications|Destruction|Refresh|Read) complete after ((?:\\d+m)?\\d+)s(?:\\s*\\[(.*)\\])?`,
)

// Error events: "Error: ..." after a resource address context
const ERROR_RE = new RegExp(
  `^Error: (.+)`,
)

// Maps terraform verbs to our action types
const VERB_TO_ACTION: Record<string, ResourceSpanEvent["action"]> = {
  Creating: "create",
  Modifying: "update",
  Destroying: "delete",
  Refreshing: "refresh",
  Reading: "read",
  creating: "create",
  modifying: "update",
  destroying: "delete",
  refreshing: "refresh",
  reading: "read",
  Creation: "create",
  Modifications: "update",
  Destruction: "delete",
  Refresh: "refresh",
  Read: "read",
}

/**
 * Parse a duration string like "32", "1m8", "1m0" into milliseconds.
 * The input is the part before the trailing "s" (already stripped by regex).
 */
function parseDurationToMs(raw: string): number {
  const mMatch = raw.match(/^(\d+)m(\d+)$/)
  if (mMatch) {
    return (Number(mMatch[1]) * 60 + Number(mMatch[2])) * 1000
  }
  return Number(raw) * 1000
}

/**
 * Extract resource type from a resource address.
 * "module.vpc.aws_subnet.public[0]" -> "aws_subnet"
 * "aws_s3_bucket.foo" -> "aws_s3_bucket"
 * "module.core.data.aws_availability_zones.available" -> "aws_availability_zones"
 */
function extractResourceType(address: string): string {
  // Strip module prefixes and data. prefix
  const parts = address.split(".")
  let i = 0
  while (i < parts.length - 2 && parts[i] === "module") {
    i += 2 // skip "module" and the module name
  }
  // Skip "data" prefix for data sources
  if (parts[i] === "data" && i < parts.length - 2) {
    i += 1
  }
  return parts[i] ?? address
}

export class ResourceSpanParser {
  private buffer = ""
  private readonly callback: SpanEventCallback
  // Track last resource address seen for error context
  private lastResourceAddress: string | null = null
  private lastAction: ResourceSpanEvent["action"] | null = null

  constructor(callback: SpanEventCallback) {
    this.callback = callback
  }

  /**
   * Feed a chunk of stdout/stderr output to the parser.
   * May contain partial lines — buffered until newline.
   */
  feed(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split("\n")
    // Last element is either empty (chunk ended with \n) or a partial line
    this.buffer = lines.pop() ?? ""

    for (const line of lines) {
      this.parseLine(line.trim())
    }
  }

  /**
   * Flush any remaining buffered content (call at end of stream).
   */
  flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer.trim())
    }
    this.buffer = ""
  }

  private parseLine(line: string): void {
    if (!line) return

    // Try start event (Creating/Modifying/Destroying/Reading)
    let match = line.match(START_RE)
    if (match) {
      const [, address, verb] = match
      const action = VERB_TO_ACTION[verb] ?? "create"
      this.lastResourceAddress = address
      this.lastAction = action
      this.callback({
        resourceAddress: address,
        resourceType: extractResourceType(address),
        action,
        event: "started",
        timestamp: Date.now(),
      })
      return
    }

    // Try refresh start event ("Refreshing state...")
    match = line.match(REFRESH_START_RE)
    if (match) {
      const [, address] = match
      this.lastResourceAddress = address
      this.lastAction = "refresh"
      this.callback({
        resourceAddress: address,
        resourceType: extractResourceType(address),
        action: "refresh",
        event: "started",
        timestamp: Date.now(),
      })
      return
    }

    // Try progress event ("Still creating... [30s elapsed]" or "Still modifying... [id=X, 10s elapsed]")
    match = line.match(PROGRESS_RE)
    if (match) {
      const [, address, verb, elapsed] = match
      const action = VERB_TO_ACTION[verb] ?? "create"
      this.lastResourceAddress = address
      this.lastAction = action
      this.callback({
        resourceAddress: address,
        resourceType: extractResourceType(address),
        action,
        event: "progress",
        timestamp: Date.now(),
        elapsedMs: parseDurationToMs(elapsed),
      })
      return
    }

    // Try complete event ("Creation complete after 1m8s [id=...]")
    match = line.match(COMPLETE_RE)
    if (match) {
      const [, address, verb, elapsed, detail] = match
      const action = VERB_TO_ACTION[verb] ?? "create"
      this.lastResourceAddress = address
      this.lastAction = action
      this.callback({
        resourceAddress: address,
        resourceType: extractResourceType(address),
        action,
        event: "complete",
        timestamp: Date.now(),
        elapsedMs: parseDurationToMs(elapsed),
        message: detail ?? undefined,
      })
      return
    }

    // Try error event
    match = line.match(ERROR_RE)
    if (match && this.lastResourceAddress && this.lastAction) {
      this.callback({
        resourceAddress: this.lastResourceAddress,
        resourceType: extractResourceType(this.lastResourceAddress),
        action: this.lastAction,
        event: "error",
        timestamp: Date.now(),
        message: match[1],
      })
      return
    }
  }
}
