import type { ClaimResponse } from "./api-client.ts"

export interface WarmRunnerConfig {
  apiUrl: string
  runnerToken: string
}

export interface WarmRunnerRegistration {
  runnerId: string
  orgId: string
  maxSlots: number
  heartbeatIntervalMs: number
  pollIntervalMs: number
  idleShutdownMs: number
}

export interface WarmRunnerClaimResponse extends ClaimResponse {
  jobToken?: string
}

export class WarmRunnerApiClient {
  private readonly config: WarmRunnerConfig

  constructor(config: WarmRunnerConfig) {
    this.config = config
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.runnerToken}`,
      "Content-Type": "application/json",
    }
  }

  async register(
    workerId: string,
    maxSlots: number,
    metadata?: Record<string, unknown>,
  ): Promise<WarmRunnerRegistration> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/warm/register`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ workerId, maxSlots, metadata }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to register warm runner: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }

  async heartbeat(runnerId: string, workerId: string, activeSlots: number): Promise<void> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/warm/heartbeat`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ runnerId, workerId, activeSlots }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to heartbeat warm runner: ${response.status} ${error}`)
    }
  }

  async claimNext(runnerId: string, workerId: string, availableSlots: number): Promise<WarmRunnerClaimResponse> {
    const response = await fetch(`${this.config.apiUrl}/api/runner/warm/claim-next`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ runnerId, workerId, availableSlots }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to claim next warm job: ${response.status} ${error}`)
    }

    const result = await response.json()
    return result.data
  }
}
