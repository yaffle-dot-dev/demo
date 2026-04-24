import type { CiTarget, EnvironmentKind } from "../types"

export type DeployablePhase = "prepare" | "build" | "deploy" | "verify"

export type DeployableSecretAccess = "value" | "reference"

export type DeployableSecretSource =
  | {
    type: "literal"
    value: string
  }
  | {
    type: "env"
    name: string
  }
  | {
    type: "aws-secretsmanager"
    secretId: string
  }
  | {
    type: "workspace-output"
    workspace: string
    output: string
    outputType?: "plain" | "aws-secret-id" | "aws-secret-arn"
  }

export type DeployableSecretDelivery =
  | {
    type: "none"
  }
  | {
    type: "env"
    name: string
  }
  | {
    type: "file"
    pathEnvVar: string
    fileName?: string
  }

export interface DeployableSecretDefinition {
  name: string
  phase: DeployablePhase
  access: DeployableSecretAccess
  source: DeployableSecretSource
  delivery: DeployableSecretDelivery
  optional?: boolean
  fallbacks?: DeployableSecretSource[]
  ensure?: {
    strategy: "generate-random"
    bytes?: number
  }
}

export interface DeployableExecutionContext {
  target: CiTarget
  dryRun: boolean
}

export interface DeployableDefinition {
  name: string
  root: string
  supports: {
    environmentKinds: EnvironmentKind[]
  }
  workspaces: string[]
  watchedPaths: string[]
  secrets?: DeployableSecretDefinition[]
  prepare?: (context: DeployableExecutionContext) => Promise<void>
  build: (context: DeployableExecutionContext) => Promise<void>
  deploy: (context: DeployableExecutionContext) => Promise<void>
  verify?: (context: DeployableExecutionContext) => Promise<void>
}

export interface DiscoveredDeployable extends DeployableDefinition {
  descriptorPath: string
}

export function defineDeployable(definition: DeployableDefinition): DeployableDefinition {
  return definition
}
