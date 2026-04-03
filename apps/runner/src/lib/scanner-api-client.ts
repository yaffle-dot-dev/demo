/**
 * Scanner API Client
 *
 * HTTP client for communicating with the control plane scanner API.
 * Used by the scanner worker to claim scan jobs, send heartbeats,
 * and report results.
 */

export interface ScannerConfig {
  apiUrl: string
  jobToken: string
  scanJobId: string
}

export interface ScanClaimResponse {
  scanJobId: string
  runGroupId: string
  repoUrl: string
  ref: string
  headSha: string
  installationToken?: string
  orgSlug: string
  workspacePaths: string[]
  workspaceUploadUrl?: string
}

export interface ScanResult {
  graph: { workspaces: string[]; edges: [string, string][] }
  executionOrder: string[]
  workspaceS3Key?: string
}

export class ScannerApiClient {
  private readonly apiUrl: string
  private readonly jobToken: string
  private readonly scanJobId: string

  constructor(config: ScannerConfig) {
    this.apiUrl = config.apiUrl
    this.jobToken = config.jobToken
    this.scanJobId = config.scanJobId
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.apiUrl}/api/scanner${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.jobToken}`,
        "x-worker-id": `scanner-${process.pid}`,
        ...options.headers,
      },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`API request failed: ${response.status} ${text}`)
    }

    return response
  }

  /**
   * Claim the scan job. Returns inputs needed for scanning.
   */
  async claim(workerId: string): Promise<ScanClaimResponse> {
    const response = await this.request("/claim", {
      method: "POST",
      headers: { "x-worker-id": workerId },
    })

    return response.json()
  }

  /**
   * Send heartbeat. Compatible with HeartbeatSupervisor interface.
   */
  async heartbeat(): Promise<{ success: boolean; reason?: string }> {
    try {
      const response = await this.request("/heartbeat", {
        method: "POST",
      })

      const data = await response.json()
      return { success: data.continue !== false }
    } catch (err) {
      throw err
    }
  }

  /**
   * Report successful scan completion with results.
   */
  async complete(result: ScanResult): Promise<void> {
    await this.request("/complete", {
      method: "POST",
      body: JSON.stringify(result),
    })
  }

  /**
   * Report scan failure.
   */
  async fail(errorMessage: string): Promise<void> {
    await this.request("/complete", {
      method: "POST",
      body: JSON.stringify({ error: errorMessage }),
    })
  }
}
