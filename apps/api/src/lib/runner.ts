import type { RunType, TerraformResult } from "@yaffle/shared"

/**
 * Interface for running terraform operations.
 * The webhook handler depends on this so we can swap implementations:
 * - LocalRunner: clones repo, shells out to tofu (dev / local)
 * - EcsRunner: triggers ECS Fargate task (production, future)
 * - TestRunner: returns canned results (tests)
 */
export interface Runner {
  /**
   * Execute a terraform command against a repo at a specific SHA.
   * The runner is responsible for workspace setup and cleanup.
   */
  run(opts: {
    owner: string
    repo: string
    headSha: string
    command: RunType
    variables?: Record<string, string>
    installationToken?: string
  }): Promise<TerraformResult>
}
