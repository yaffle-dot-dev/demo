/**
 * Yaffle API client.
 */

import { EventSource } from "eventsource"
import type { AuthProvider } from "./auth.js"
import type {
  ApiResponse,
  EnvironmentGroup,
  EnvironmentPreviewGroup,
  OrgInfo,
  Preview,
  PreviewOverviewResponse,
  PreviewStatus,
  ResourceSpan,
  Run,
  StreamUpdate,
  Target,
  TerraformOutput,
  WorkspacePreview,
} from "./types.js"

export interface YaffleClientOptions {
  /** Yaffle API base URL */
  apiUrl: string
  /** Authentication provider */
  auth: AuthProvider
  /** Logger for debug output */
  logger?: Logger
}

export interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type OutputWaitCondition = "outputs" | "usable"

const defaultLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return JSON.stringify(error) ?? "Unknown error"
}

function createAuthenticatedEventSource(url: string, token: string): EventSource {
  return new EventSource(url, {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set("Authorization", `Bearer ${token}`)
      return fetch(input, { ...init, headers })
    },
  })
}

export class YaffleClient {
  private apiUrl: string
  private auth: AuthProvider
  private log: Logger

  constructor(options: YaffleClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "") // Remove trailing slash
    this.auth = options.auth
    this.log = options.logger ?? defaultLogger
  }

  /**
   * Make an authenticated API request
   */
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const credentials = await this.auth.getCredentials()
    const headers = new Headers(options.headers)
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${credentials.accessToken}`)
    }
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json")
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`API request failed: ${response.status} ${text}`)
    }

    return response.json()
  }

  private async requestText(path: string, options: RequestInit = {}): Promise<string> {
    const credentials = await this.auth.getCredentials()
    const headers = new Headers(options.headers)
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${credentials.accessToken}`)
    }
    if (!headers.has("Accept")) {
      headers.set("Accept", "text/plain, application/json")
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`API request failed: ${response.status} ${text}`)
    }

    return response.text()
  }

  /**
   * Find a preview by PR number or environment
   */
  async findPreview(
    org: string,
    repo: string,
    target: Target,
    workspace: string,
  ): Promise<Preview | null> {
    const params = new URLSearchParams({
      org,
      repo,
      workspace_path: workspace,
    })

    if (target.type === "pr") {
      params.set("pr_number", String(target.prNumber))
    } else {
      params.set("environment", target.name)
    }

    const data = await this.request<ApiResponse<Preview[]>>(`/api/previews?${params}`)

    return data.data?.[0] || null
  }

  /**
   * Get outputs for a preview by fetching the full workspace data
   */
  async getPreviewOutputs(
    org: string,
    repo: string,
    target: Target,
    workspace: string,
  ): Promise<Record<string, TerraformOutput> | null> {
    const details = await this.getWorkspaceDetails(org, repo, target, workspace)
    return details.outputs
  }

  private async getWorkspaceDetails(
    org: string,
    repo: string,
    target: Target,
    workspace: string,
  ): Promise<{
    preview: WorkspacePreview
    runs: Run[]
    outputs: Record<string, TerraformOutput> | null
  }> {
    try {
      const environmentName = target.type === "pr" ? `pr-${target.prNumber}` : target.name
      const path = `/api/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/environment/${encodeURIComponent(environmentName)}?output_audience=automation`

      const data = await this.request<
        ApiResponse<{
          workspaces: Array<{
            preview: WorkspacePreview
            runs: Run[]
            outputs: Record<string, TerraformOutput> | null
          }>
        }>
      >(path)

      const ws = data.data?.workspaces?.find((w) => w.preview.workspacePath === workspace)

      if (!ws) {
        throw new Error(`Workspace ${workspace} not found in target response`)
      }

      return {
        preview: ws.preview,
        runs: ws.runs,
        outputs: ws.outputs,
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) {
        throw new Error(`No workspace data found for ${workspace}`)
      }
      throw err
    }
  }

  private getLatestRun(runs: Run[]): Run | null {
    if (runs.length === 0) {
      return null
    }

    return (
      [...runs].sort((a, b) => {
        const left = new Date(a.createdAt).getTime()
        const right = new Date(b.createdAt).getTime()
        return right - left
      })[0] ?? null
    )
  }

  private buildFailedWorkspaceError(options: {
    targetLabel: string
    workspace: string
    previewStatus: string
    latestRun: Run | null
  }): Error {
    const runSummary = options.latestRun
      ? `${options.latestRun.runType} ${options.latestRun.status}`
      : "no runs recorded"
    const errorMessage = options.latestRun?.errorMessage?.trim()

    const detail = errorMessage ? ` Latest run error: ${errorMessage}` : ""

    return new Error(
      `Cannot fetch outputs for ${options.targetLabel} workspace=${options.workspace}: ` +
        `workspace status is ${options.previewStatus} and latest run is ${runSummary}.${detail}`,
    )
  }

  /**
   * Wait for a preview to reach a terminal state using SSE
   */
  async waitForPreview(previewId: string, timeoutSeconds: number = 300): Promise<StreamUpdate> {
    const credentials = await this.auth.getCredentials()

    return new Promise((resolve, reject) => {
      const timeoutMs = timeoutSeconds * 1000
      const url = `${this.apiUrl}/api/previews/${previewId}/stream`

      this.log.info(`Waiting for preview ${previewId}...`)

      const es = createAuthenticatedEventSource(url, credentials.accessToken)
      let resolved = false

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          es.close()
          reject(new Error(`Timeout waiting for preview after ${timeoutSeconds}s`))
        }
      }, timeoutMs)

      es.addEventListener("update", (event: MessageEvent) => {
        if (resolved) return

        try {
          const data = JSON.parse(event.data) as StreamUpdate

          if (!data.preview) {
            this.log.warn("Received update with no preview data")
            return
          }

          this.log.info(`Preview status: ${data.preview.status}`)

          // Check for terminal states
          if (data.preview.status === "ready") {
            resolved = true
            clearTimeout(timeout)
            es.close()
            resolve(data)
          } else if (data.preview.status === "failed") {
            resolved = true
            clearTimeout(timeout)
            es.close()
            reject(new Error("Preview failed"))
          } else if (data.preview.status === "destroyed") {
            resolved = true
            clearTimeout(timeout)
            es.close()
            reject(new Error("Preview was destroyed"))
          }
        } catch (err) {
          this.log.warn(`Failed to parse SSE event: ${formatError(err)}`)
        }
      })

      es.onerror = (err: Event) => {
        if (resolved) return
        this.log.warn(`SSE connection error: ${err.type}`)

        setTimeout(() => {
          if (!resolved && es.readyState === 2) {
            resolved = true
            clearTimeout(timeout)
            reject(new Error("SSE connection closed unexpectedly"))
          }
        }, 5000)
      }

      es.onopen = () => {
        this.log.info("Connected to preview stream")
      }
    })
  }

  /**
   * Get outputs for a target, optionally waiting for outputs or usable readiness.
   */
  async getOutputs(options: {
    org: string
    repo: string
    target: Target
    workspace: string
    waitFor?: OutputWaitCondition
    waitTimeout?: number
  }): Promise<{
    previewId: string
    status: string
    outputs: Record<string, TerraformOutput> | null
    latestRun: Run | null
  }> {
    const { org, repo, target, workspace, waitFor, waitTimeout = 300 } = options

    const targetLabel = target.type === "pr" ? `PR #${target.prNumber}` : `env: ${target.name}`

    this.log.info(`Fetching outputs for ${org}/${repo} ${targetLabel} workspace=${workspace}`)

    const initialDetails = await this.getWorkspaceDetails(org, repo, target, workspace)
    const preview = initialDetails.preview

    this.log.info(`Found preview ${preview.id} with status: ${preview.status}`)

    let outputs: Record<string, TerraformOutput> | null = initialDetails.outputs
    let status: PreviewStatus = preview.status
    let latestRun: Run | null = this.getLatestRun(initialDetails.runs)

    if (waitFor && (preview.status === "failed" || preview.status === "destroyed")) {
      throw this.buildFailedWorkspaceError({
        targetLabel,
        workspace,
        previewStatus: preview.status,
        latestRun,
      })
    }

    if (waitFor === "outputs" && outputs === null) {
      this.log.info(`Waiting for workspace outputs (timeout: ${waitTimeout}s)...`)
      try {
        const result = await this.waitForPreviewOutputs(preview.id, waitTimeout)
        status = result.preview?.status ?? status
        const details = await this.getWorkspaceDetails(org, repo, target, workspace)
        latestRun = this.getLatestRun(details.runs)
        outputs = details.outputs
      } catch {
        const details = await this.getWorkspaceDetails(org, repo, target, workspace)
        latestRun = this.getLatestRun(details.runs)
        if (
          details.outputs !== null &&
          details.preview.status !== "failed" &&
          details.preview.status !== "destroyed"
        ) {
          status = details.preview.status
          outputs = details.outputs
        } else {
          throw this.buildFailedWorkspaceError({
            targetLabel,
            workspace,
            previewStatus: details.preview.status,
            latestRun,
          })
        }
      }
    }

    if (waitFor === "usable" && status !== "ready") {
      this.log.info(`Waiting for workspace to be usable (timeout: ${waitTimeout}s)...`)
      try {
        const result = await this.waitForPreview(preview.id, waitTimeout)
        status = result.preview?.status ?? "failed"
        outputs = result.outputs
      } catch {
        const details = await this.getWorkspaceDetails(org, repo, target, workspace)
        latestRun = this.getLatestRun(details.runs)
        if (details.preview.status !== "ready") {
          throw this.buildFailedWorkspaceError({
            targetLabel,
            workspace,
            previewStatus: details.preview.status,
            latestRun,
          })
        }
        status = details.preview.status
        outputs = details.outputs
      }
    }

    if (waitFor === "usable" && status === "ready") {
      const details = await this.getWorkspaceDetails(org, repo, target, workspace)
      status = details.preview.status
      latestRun = this.getLatestRun(details.runs)

      if (details.preview.status === "failed" || latestRun?.status === "failed") {
        throw this.buildFailedWorkspaceError({
          targetLabel,
          workspace,
          previewStatus: details.preview.status,
          latestRun,
        })
      }

      outputs = details.outputs
    }

    return {
      previewId: preview.id,
      status,
      outputs,
      latestRun,
    }
  }

  async waitForPreviewOutputs(
    previewId: string,
    timeoutSeconds: number = 300,
  ): Promise<StreamUpdate> {
    const credentials = await this.auth.getCredentials()

    return new Promise((resolve, reject) => {
      const timeoutMs = timeoutSeconds * 1000
      const url = `${this.apiUrl}/api/previews/${previewId}/stream`

      this.log.info(`Waiting for preview ${previewId} outputs...`)

      const es = createAuthenticatedEventSource(url, credentials.accessToken)
      let resolved = false

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          es.close()
          reject(new Error(`Timeout waiting for preview outputs after ${timeoutSeconds}s`))
        }
      }, timeoutMs)

      es.addEventListener("update", (event: MessageEvent) => {
        if (resolved) return

        try {
          const data = JSON.parse(event.data) as StreamUpdate

          if (!data.preview) {
            this.log.warn("Received update with no preview data")
            return
          }

          this.log.info(`Preview status: ${data.preview.status}`)

          if (data.outputs !== null) {
            resolved = true
            clearTimeout(timeout)
            es.close()
            resolve(data)
          } else if (data.preview.status === "failed") {
            resolved = true
            clearTimeout(timeout)
            es.close()
            reject(new Error("Preview failed"))
          } else if (data.preview.status === "destroyed") {
            resolved = true
            clearTimeout(timeout)
            es.close()
            reject(new Error("Preview was destroyed"))
          }
        } catch (err) {
          this.log.warn(`Failed to parse SSE event: ${formatError(err)}`)
        }
      })

      es.onerror = (err: Event) => {
        if (resolved) return
        this.log.warn(`SSE connection error: ${err.type}`)

        setTimeout(() => {
          if (!resolved && es.readyState === 2) {
            resolved = true
            clearTimeout(timeout)
            reject(new Error("SSE connection closed unexpectedly"))
          }
        }, 5000)
      }

      es.onopen = () => {
        this.log.info("Connected to preview stream")
      }
    })
  }

  /**
   * List all previews for a repository
   */
  async listPreviews(org: string, repo: string): Promise<Preview[]> {
    const data = await this.request<ApiResponse<Preview[]>>(
      `/api/previews?org=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}`,
    )
    return data.data || []
  }

  async listOrgs(): Promise<OrgInfo[]> {
    const data = await this.request<ApiResponse<OrgInfo[]>>("/api/orgs")
    return data.data || []
  }

  async listEnvironments(options: {
    org: string
    repo?: string
    view?: "full" | "dag"
  }): Promise<EnvironmentGroup[]> {
    const searchParams = new URLSearchParams({
      org: options.org,
    })

    if (options.repo) {
      searchParams.set("repo", options.repo)
    }

    if (options.view) {
      searchParams.set("view", options.view)
    }

    const data = await this.request<ApiResponse<EnvironmentGroup[]>>(
      `/api/environments?${searchParams}`,
    )

    return data.data || []
  }

  async getPreviewOverview(options: {
    org: string
    repo?: string
    status?: string
    prNumber?: number
    limit?: number
    cursor?: string
  }): Promise<PreviewOverviewResponse> {
    const searchParams = new URLSearchParams({
      org: options.org,
    })

    if (options.repo) {
      searchParams.set("repo", options.repo)
    }

    if (options.status) {
      searchParams.set("status", options.status)
    }

    if (options.prNumber != null) {
      searchParams.set("pr_number", String(options.prNumber))
    }

    if (options.limit != null) {
      searchParams.set("limit", String(options.limit))
    }

    if (options.cursor) {
      searchParams.set("cursor", options.cursor)
    }

    return this.request<PreviewOverviewResponse>(`/api/previews/overview?${searchParams}`)
  }

  async getEnvironment(options: {
    org: string
    repo: string
    environmentName: string
    view?: "full" | "dag"
  }): Promise<EnvironmentPreviewGroup> {
    const searchParams = new URLSearchParams()
    if (options.view) {
      searchParams.set("view", options.view)
    }

    const suffix = searchParams.size > 0 ? `?${searchParams}` : ""
    const data = await this.request<ApiResponse<EnvironmentPreviewGroup>>(
      `/api/orgs/${encodeURIComponent(options.org)}/repos/${encodeURIComponent(options.repo)}/environment/${encodeURIComponent(options.environmentName)}${suffix}`,
    )

    return data.data
  }

  async getRun(runId: string): Promise<Run> {
    const data = await this.request<ApiResponse<Run>>(`/api/runs/${encodeURIComponent(runId)}`)
    return data.data
  }

  async getRunOutput(runId: string): Promise<string> {
    return this.requestText(`/api/runs/${encodeURIComponent(runId)}/output`)
  }

  async getRunSpans(runId: string): Promise<ResourceSpan[]> {
    const data = await this.request<ApiResponse<ResourceSpan[]>>(
      `/api/runs/${encodeURIComponent(runId)}/spans`,
    )
    return data.data || []
  }

  async rerunPreview(
    previewId: string,
  ): Promise<{ rerunQueued: boolean; runGroupId: string; jobId: string }> {
    const data = await this.request<
      ApiResponse<{ rerunQueued: boolean; runGroupId: string; jobId: string }>
    >(`/api/previews/${encodeURIComponent(previewId)}/rerun`, { method: "POST" })

    return data.data
  }

  async triggerApply(previewId: string): Promise<{ applyStarted: boolean; jobId: string }> {
    const data = await this.request<ApiResponse<{ applyStarted: boolean; jobId: string }>>(
      `/api/previews/${encodeURIComponent(previewId)}/apply`,
      { method: "POST" },
    )

    return data.data
  }

  async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    const data = await this.request<ApiResponse<{ cancelled: boolean }>>(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    )

    return data.data
  }
}
