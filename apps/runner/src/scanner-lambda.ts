/**
 * Lambda entry point for the scanner worker.
 *
 * Supports two modes:
 * - healthcheck: verifies Tailscale connectivity, git, secrets access
 * - scan: runs the actual dependency scanner
 */

import { execSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { runScanner } from "./scanner-main.ts"

let tailscaleStarted = false

/**
 * Start Tailscale in userspace networking mode.
 * Fetches auth key from Secrets Manager via the secrets extension,
 * then starts tailscaled and connects to the tailnet.
 * Reuses the connection across warm Lambda invocations.
 */
async function ensureTailscale(): Promise<void> {
  if (tailscaleStarted) return

  if (!existsSync("/opt/bin/tailscaled")) {
    console.log("[lambda] Tailscale layer not present, skipping")
    return
  }

  // Get auth key — try env var first, then secrets extension
  let authkey = process.env.TAILSCALE_AUTHKEY
  if (!authkey && process.env.TAILSCALE_AUTHKEY_SECRET_ARN) {
    try {
      const secretArn = process.env.TAILSCALE_AUTHKEY_SECRET_ARN
      const response = await fetch(
        `http://localhost:2773/secretsmanager/get?secretId=${encodeURIComponent(secretArn)}`,
        { headers: { "X-Aws-Parameters-Secrets-Token": process.env.AWS_SESSION_TOKEN ?? "" } },
      )
      if (response.ok) {
        const data = await response.json() as { SecretString: string }
        const parsed = JSON.parse(data.SecretString)
        authkey = parsed.authkey
      }
    } catch (err) {
      console.error("[lambda] Failed to fetch Tailscale auth key:", String(err))
    }
  }

  if (!authkey) {
    console.log("[lambda] No Tailscale auth key available, skipping")
    return
  }

  try {
    console.log("[lambda] Starting tailscaled...")
    execSync("mkdir -p /tmp/tailscale/state", { stdio: "pipe" })

    // Start tailscaled as a detached background process
    // Use HTTP proxy (not SOCKS5) so Node.js fetch can use it via undici ProxyAgent
    const daemon = spawn("/opt/bin/tailscaled", [
      "--tun=userspace-networking",
      "--socks5-server=localhost:1055",
      "--outbound-http-proxy-listen=localhost:1056",
      "--state=/tmp/tailscale/state/tailscale.state",
      "--socket=/tmp/tailscale/tailscaled.sock",
      "--no-logs-no-support",
    ], { detached: true, stdio: "ignore" })
    daemon.unref()

    // Wait for daemon to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000))

    console.log("[lambda] Connecting to tailnet...")
    const { spawnSync } = await import("node:child_process")
    const tsUp = spawnSync("/opt/bin/tailscale", [
      "--socket=/tmp/tailscale/tailscaled.sock",
      "up",
      `--authkey=${authkey}`,
      `--hostname=${process.env.TS_HOSTNAME ?? "yaffle-scanner-lambda"}`,
      `--advertise-tags=${process.env.TS_ADVERTISE_TAGS ?? "tag:ecs-runner"}`,
    ], { stdio: "pipe", encoding: "utf-8" })

    if (tsUp.status !== 0) {
      throw new Error(`tailscale up failed (exit ${tsUp.status}): ${tsUp.stderr}`)
    }

    // Set proxy env vars — HTTP proxy for Node.js fetch, SOCKS5 for curl
    process.env.ALL_PROXY = "http://localhost:1056"
    process.env.HTTP_PROXY = "http://localhost:1056"
    process.env.HTTPS_PROXY = "http://localhost:1056"
    process.env.SOCKS_PROXY = "socks5://localhost:1055"
    process.env.NO_PROXY = "127.0.0.1,localhost,169.254.169.254,169.254.170.2,.amazonaws.com"

    // Set global fetch dispatcher to route through Tailscale's HTTP proxy
    try {
      const { setGlobalDispatcher, ProxyAgent } = await import("undici")
      setGlobalDispatcher(new ProxyAgent("http://localhost:1056"))
      console.log("[lambda] Global fetch proxy set to http://localhost:1056")
    } catch (err) {
      console.error("[lambda] Failed to set global proxy dispatcher:", String(err))
    }

    tailscaleStarted = true
    console.log("[lambda] Tailscale connected")
  } catch (err) {
    console.error("[lambda] Tailscale startup failed:", String(err))
  }
}

interface ScanEvent {
  action: "scan"
  YAFFLE_SCAN_JOB_ID: string
  YAFFLE_JOB_TOKEN: string
  YAFFLE_API_URL: string
}

interface HealthCheckEvent {
  action: "healthcheck"
  /** Optional URL to verify Tailscale connectivity (e.g., your CP health endpoint) */
  pingUrl?: string
}

type LambdaEvent = ScanEvent | HealthCheckEvent

interface LambdaResponse {
  statusCode: number
  body: string
  checks?: Record<string, { ok: boolean; detail?: string }>
}

/**
 * Run health checks to verify all operational dependencies.
 */
async function healthcheck(event: HealthCheckEvent): Promise<LambdaResponse> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {}

  // Check: fetch works (used for GitHub tarball download)
  try {
    const response = await fetch("https://api.github.com/", {
      headers: { "User-Agent": "yaffle-scanner" },
      signal: AbortSignal.timeout(5000),
    })
    checks.fetch = { ok: response.ok, detail: `github api → ${response.status}` }
  } catch (err) {
    checks.fetch = { ok: false, detail: String(err) }
  }

  // Check: Tailscale is connected
  try {
    const status = execSync(
      "/opt/bin/tailscale --socket=/tmp/tailscale/tailscaled.sock status --json 2>/dev/null || echo '{}'",
      { encoding: "utf-8" },
    )
    const parsed = JSON.parse(status)
    if (parsed.Self?.Online) {
      checks.tailscale = { ok: true, detail: `connected as ${parsed.Self.HostName}` }
    } else {
      checks.tailscale = { ok: false, detail: "not connected" }
    }
  } catch (err) {
    checks.tailscale = { ok: false, detail: String(err) }
  }

  // Check: Tailscale can reach a URL (if provided)
  // Uses the global proxy dispatcher set by ensureTailscale()
  if (event.pingUrl) {
    try {
      const response = await fetch(event.pingUrl, { signal: AbortSignal.timeout(5000) })
      checks.tailscale_reach = { ok: response.ok, detail: `${event.pingUrl} → ${response.status}` }
    } catch (err) {
      checks.tailscale_reach = { ok: false, detail: `${event.pingUrl} → ${String(err)}` }
    }
  }

  // Check: Secrets extension can read secrets (proves both extension and IAM work)
  const secretArn = process.env.TAILSCALE_AUTHKEY_SECRET_ARN
  if (secretArn) {
    try {
      const response = await fetch(
        `http://localhost:2773/secretsmanager/get?secretId=${encodeURIComponent(secretArn)}`,
        { headers: { "X-Aws-Parameters-Secrets-Token": process.env.AWS_SESSION_TOKEN ?? "" } },
      )
      if (response.ok) {
        checks.secrets = { ok: true, detail: "tailscale auth key readable" }
      } else {
        checks.secrets = { ok: false, detail: `status ${response.status}` }
      }
    } catch (err) {
      checks.secrets = { ok: false, detail: String(err) }
    }
  }

  // Core checks must pass; tailscale/secrets are optional (only when layers attached)
  const optionalChecks = new Set(["tailscale", "tailscale_reach", "secrets"])
  const allOk = Object.entries(checks).every(([name, c]) => optionalChecks.has(name) || c.ok)

  console.log("[healthcheck]", JSON.stringify(checks, null, 2))

  return {
    statusCode: allOk ? 200 : 500,
    body: allOk ? "all checks passed" : "some checks failed",
    checks,
  }
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  // Start Tailscale on first invocation (reused across warm invocations)
  await ensureTailscale()

  // Default to healthcheck if no action specified (backwards compat with old events)
  const action = ("action" in event && event.action) || (("YAFFLE_SCAN_JOB_ID" in event) ? "scan" : "healthcheck")

  if (action === "healthcheck") {
    return healthcheck(event as HealthCheckEvent)
  }

  const scanEvent = event as ScanEvent
  process.env.YAFFLE_SCAN_JOB_ID = scanEvent.YAFFLE_SCAN_JOB_ID
  process.env.YAFFLE_JOB_TOKEN = scanEvent.YAFFLE_JOB_TOKEN
  process.env.YAFFLE_API_URL = scanEvent.YAFFLE_API_URL

  try {
    await runScanner()
    return { statusCode: 200, body: "ok" }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[lambda] Scanner invocation failed:", msg)
    return { statusCode: 500, body: msg }
  }
}
