/**
 * Yaffle API types
 */

export interface Preview {
  id: string
  status: PreviewStatus
  repo: string
  prNumber: number | null
  environment: string | null
  workspacePath: string
  createdAt: string
  updatedAt: string
}

export type PreviewStatus =
  | "pending"
  | "planning"
  | "planned"
  | "applying"
  | "ready"
  | "failed"
  | "destroyed"

export interface TerraformOutput {
  value: unknown
  type?: string
  sensitive?: boolean
}

export interface Run {
  id: string
  previewId: string
  status: RunStatus
  type: "plan" | "apply" | "destroy"
  createdAt: string
  updatedAt: string
}

export type RunStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "cancelled"

export interface StreamUpdate {
  preview: Preview | null
  runs: Run[]
  outputs: Record<string, TerraformOutput> | null
}

/**
 * Target for fetching outputs - either a PR or a named environment
 */
export type Target =
  | { type: "pr"; prNumber: number }
  | { type: "env"; name: string }

/**
 * Credentials for authenticating with Yaffle API
 */
export interface Credentials {
  /** Access token (JWT or session token) */
  accessToken: string
  /** Optional refresh token for token refresh */
  refreshToken?: string
  /** Token expiry timestamp (ms since epoch) */
  expiresAt?: number
}

/**
 * Result of device flow initiation
 */
export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  data: T
}

export interface ApiError {
  error: {
    code: string
    message: string
  }
}
