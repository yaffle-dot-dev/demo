/**
 * Runner API Client
 *
 * HTTP client for communicating with the control plane runner API.
 * Used by worker processes to claim jobs, send heartbeats, and report completion.
 */

export interface RunnerConfig {
  apiUrl: string
  jobToken: string
  jobId: string
}

export interface JobDetails {
  id: string
  jobType: "plan" | "apply" | "destroy"
  status: string
  deploymentId: string
  queuedAt: string
  startedAt?: string
}

export interface DeploymentDetails {
  id: string
  orgId: string
  repo: string
  environmentKind: string
  environmentName: string
  prNumber: number | null
  workspacePath: string
  ref: string
  headSha: string
  stateKey: string
  installationId: number | null
  runGroupId: string | null
}

export interface ClaimResponse {
  claimed: boolean
  job?: JobDetails
  runId?: string  // tf_run ID for log streaming
  deployment?: DeploymentDetails
}

export interface ExecutionContext {
  workspaceUrl: string
  command: "plan" | "apply" | "destroy"
  workspacePath: string
  variables: Record<string, string | boolean | number>
  executionEnv?: Record<string, string>
  backendConfig?: {
    hostname: string
    organization: string
    workspaceName: string
    credentialHosts?: string[]
  }
  tfcToken?: string
  /** Presigned URL to download the saved plan file (apply only) */
  planFileUrl?: string
}

export interface SpanEvent {
  resourceAddress: string
  resourceType: string
  action: string
  event: string
  timestamp: number
  elapsedMs?: number
  message?: string
}

export interface LogsResponse {
  success: boolean
}

export interface HeartbeatResponse {
  success: boolean
  reason?: string
}

export interface CompleteResponse {
  success: boolean
}

export interface JobCompletionResult {
  logOutput?: string
  [key: string]: unknown
}

export class RunnerApiClient {
  private readonly config: RunnerConfig

  constructor(config: RunnerConfig) {
    this.config = config
  }

  private get headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.config.jobToken}`,
      "Content-Type": "application/json",
    }
  }

  /**
   * Claim a job atomically.
   * Returns job details if claimed, null if already claimed.
   */
  async claim(workerId: string): Promise<ClaimResponse | null> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/claim`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        jobId: this.config.jobId,
        workerId,
      }),
    })

    if (response.status === 409) {
      // Job already claimed
      return null
    }

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to claim job: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  /**
   * Send heartbeat to indicate worker is still alive.
   * Returns false if job is no longer in running state.
   */
  async heartbeat(): Promise<HeartbeatResponse> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/heartbeat`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        jobId: this.config.jobId,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to send heartbeat: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  /**
   * Report job completion with result.
   */
  async complete(runId: string, result: JobCompletionResult): Promise<CompleteResponse> {
    const { logOutput, ...completionResult } = result

    const response = await fetch(`${this.config.apiUrl}/api/runner/complete`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        jobId: this.config.jobId,
        runId,
        status: "completed",
        result: completionResult,
        ...(typeof logOutput === "string" ? { logOutput } : {}),
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to complete job: ${response.status} ${error}`)
    }

    const result_ = await response.json()
    return result_.data
  }

  /**
   * Report job failure with error message.
   */
  async fail(
    runId: string,
    errorMessage: string,
    opts?: { logOutput?: string },
  ): Promise<CompleteResponse> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/complete`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        jobId: this.config.jobId,
        runId,
        status: "failed",
        errorMessage,
        logOutput: opts?.logOutput,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to fail job: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  /**
   * Get job details.
   */
  async getJob(): Promise<{ job: JobDetails; deployment: DeploymentDetails } | null> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/job/${this.config.jobId}`, {
      method: "GET",
      headers: this.headers,
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get job: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  /**
   * Get execution context for the job.
   * Returns workspace URL, variables, backend config, etc.
   */
  async getContext(): Promise<ExecutionContext> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/job/${this.config.jobId}/context`, {
      method: "GET",
      headers: this.headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get job context: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  /**
   * Get a presigned URL for uploading the plan file binary.
   */
  async getPlanFileUploadUrl(runId: string): Promise<{ uploadUrl: string; s3Key: string }> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/plan-file-url`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ runId }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get plan file upload URL: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  /**
   * Upload a plan file binary to S3 via presigned URL.
   */
  async uploadPlanFile(uploadUrl: string, planData: ArrayBuffer): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: planData,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to upload plan file: ${response.status} ${error}`)
    }
  }

  /**
   * Send batched resource span events to control plane.
   */
  async sendSpanEvents(runId: string, events: SpanEvent[]): Promise<{ success: boolean }> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/spans`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        jobId: this.config.jobId,
        runId,
        events,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to send span events: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  /**
   * Send log chunk to control plane.
   * @param runId - The tf_run ID returned from claim
   * @param chunk - Log text
   * @param source - "stdout" or "stderr"
   */
  async sendLogs(runId: string, chunk: string, source: "stdout" | "stderr" = "stdout"): Promise<LogsResponse> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/logs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        jobId: this.config.jobId,
        runId,
        chunk,
        source,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to send logs: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }
}
