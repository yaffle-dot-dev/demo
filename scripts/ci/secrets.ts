import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { exec } from "../lib/exec"
import { fetchOutputs } from "../lib/outputs"

import type { CiTarget } from "./types"
import type {
  DeployableDefinition,
  DeployablePhase,
  DeployableSecretDefinition,
  DeployableSecretSource,
} from "./deployables/types"

export interface DeployableSecretCheckEntry {
  deployable: string
  phase: DeployablePhase
  secret: string
  access: string
  optional: boolean
  delivery: "none" | "env" | "file"
  status: "ok" | "missing" | "optional_missing"
  detail: string
}

export interface DeployableSecretEnsureEntry {
  deployable: string
  phase: DeployablePhase
  secret: string
  status: "existing" | "written" | "skipped"
  detail: string
}

interface ResolvedSecretBinding {
  env: Record<string, string>
  cleanup: () => Promise<void>
}

type WorkspaceOutputsCache = Map<string, Promise<Record<string, unknown>>>

function interpolateTemplate(template: string, target: CiTarget): string {
  return template
    .replaceAll("${environment}", target.environment.name)
    .replaceAll("${environmentKind}", target.environment.kind)
    .replaceAll("${prNumber}", String(target.git.prNumber ?? ""))
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new Error(`${description} must be a string`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${description} is empty`)
  }

  return trimmed
}

function isPlaceholderSecretValue(value: string): boolean {
  return value.startsWith("PLACEHOLDER-")
}

function assertNotPlaceholderSecret(value: string, description: string): string {
  if (isPlaceholderSecretValue(value)) {
    throw new Error(`${description} is still a placeholder value`)
  }

  return value
}

async function getSecretValueFromAws(secretId: string): Promise<string> {
  const value = await exec(
    [
      "aws",
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      secretId,
      "--query",
      "SecretString",
      "--output",
      "text",
      "--region",
      process.env.AWS_REGION?.trim() || "us-east-1",
    ],
    {
      quiet: true,
    },
  )

  const trimmed = value.trim()
  if (!trimmed || trimmed === "None" || trimmed === "null") {
    throw new Error(`Secret ${secretId} is empty`)
  }

  return assertNotPlaceholderSecret(trimmed, `Secret ${secretId}`)
}

async function putSecretValueToAws(secretId: string, value: string): Promise<void> {
  await exec(
    [
      "aws",
      "secretsmanager",
      "put-secret-value",
      "--secret-id",
      secretId,
      "--secret-string",
      value,
      "--region",
      process.env.AWS_REGION?.trim() || "us-east-1",
    ],
    {
      quiet: true,
    },
  )
}

async function getWorkspaceOutputs(
  cache: WorkspaceOutputsCache,
  target: CiTarget,
  workspace: string,
): Promise<Record<string, unknown>> {
  const cacheKey = `${target.environment.name}:${workspace}`
  let cached = cache.get(cacheKey)

  if (!cached) {
    cached = fetchOutputs({
      workspace,
      environment: target.environment.name,
      wait: false,
    })
    cache.set(cacheKey, cached)
  }

  return cached
}

async function resolveSecretReference(
  source: DeployableSecretSource,
  target: CiTarget,
  cache: WorkspaceOutputsCache,
): Promise<string | undefined> {
  switch (source.type) {
    case "literal":
      return assertNotPlaceholderSecret(
        interpolateTemplate(source.value, target).trim(),
        "Literal secret source",
      ) || undefined
    case "env":
      return process.env[source.name]?.trim()
        ? assertNotPlaceholderSecret(process.env[source.name]!.trim(), `Environment variable ${source.name}`)
        : undefined
    case "aws-secretsmanager":
      return interpolateTemplate(source.secretId, target).trim() || undefined
    case "workspace-output": {
      const outputs = await getWorkspaceOutputs(cache, target, source.workspace)
      const value = outputs[source.output]
      if (typeof value !== "string") {
        return undefined
      }
      const trimmed = value.trim()
      return trimmed ? assertNotPlaceholderSecret(trimmed, `Workspace output ${source.workspace}.${source.output}`) : undefined
    }
  }
}

async function resolveSecretValue(
  definition: DeployableSecretDefinition,
  source: DeployableSecretSource,
  target: CiTarget,
  cache: WorkspaceOutputsCache,
): Promise<string | undefined> {
  switch (source.type) {
    case "literal":
    case "env":
      return resolveSecretReference(source, target, cache)
    case "aws-secretsmanager": {
      const secretId = await resolveSecretReference(source, target, cache)
      return secretId ? getSecretValueFromAws(secretId) : undefined
    }
    case "workspace-output": {
      const reference = await resolveSecretReference(source, target, cache)
      if (!reference) {
        return undefined
      }

      if (source.outputType === "aws-secret-id" || source.outputType === "aws-secret-arn") {
        return getSecretValueFromAws(reference)
      }

      if (definition.access === "value") {
        return reference
      }

      return reference
    }
  }
}

async function resolveDefinitionValue(
  definition: DeployableSecretDefinition,
  target: CiTarget,
  cache: WorkspaceOutputsCache,
): Promise<string> {
  const candidates = [definition.source, ...(definition.fallbacks ?? [])]
  let lastError: Error | undefined

  for (const source of candidates) {
    try {
      const value = definition.access === "reference"
        ? await resolveSecretReference(source, target, cache)
        : await resolveSecretValue(definition, source, target, cache)

      if (value) {
        return value
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (definition.optional) {
    return ""
  }

  if (lastError) {
    throw lastError
  }

  throw new Error(`Unable to resolve required secret ${definition.name}`)
}

async function resolveDefinitionWriteTarget(
  definition: DeployableSecretDefinition,
  target: CiTarget,
  cache: WorkspaceOutputsCache,
): Promise<string | undefined> {
  const candidates = [definition.source, ...(definition.fallbacks ?? [])]

  for (const source of candidates) {
    if (source.type === "aws-secretsmanager") {
      return resolveSecretReference(source, target, cache)
    }

    if (
      source.type === "workspace-output"
      && (source.outputType === "aws-secret-id" || source.outputType === "aws-secret-arn")
    ) {
      return resolveSecretReference(source, target, cache)
    }
  }

  return undefined
}

function generateRandomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url")
}

async function checkDefinition(
  definition: DeployableSecretDefinition,
  deployable: DeployableDefinition,
  target: CiTarget,
  cache: WorkspaceOutputsCache,
): Promise<DeployableSecretCheckEntry> {
  try {
    const value = await resolveDefinitionValue(definition, target, cache)
    if (!value) {
      return {
        deployable: deployable.name,
        phase: definition.phase,
        secret: definition.name,
        access: definition.access,
        optional: definition.optional ?? false,
        delivery: definition.delivery.type,
        status: "optional_missing",
        detail: "optional secret not resolved",
      }
    }

    return {
      deployable: deployable.name,
      phase: definition.phase,
      secret: definition.name,
      access: definition.access,
      optional: definition.optional ?? false,
      delivery: definition.delivery.type,
      status: "ok",
      detail: "resolved",
    }
  } catch (error) {
    return {
      deployable: deployable.name,
      phase: definition.phase,
      secret: definition.name,
      access: definition.access,
      optional: definition.optional ?? false,
      delivery: definition.delivery.type,
      status: definition.optional ? "optional_missing" : "missing",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function createBinding(
  definition: DeployableSecretDefinition,
  value: string,
): Promise<ResolvedSecretBinding | null> {
  if (!value) {
    return definition.optional
      ? null
      : {
        env: {},
        cleanup: async () => {},
      }
  }

  if (definition.delivery.type === "none") {
    return {
      env: {},
      cleanup: async () => {},
    }
  }

  if (definition.delivery.type === "env") {
    return {
      env: {
        [definition.delivery.name]: value,
      },
      cleanup: async () => {},
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), "yaffle-ci-secret-"))
  const fileName = definition.delivery.fileName ?? definition.name
  const filePath = join(tempDir, fileName)
  await writeFile(filePath, value, { mode: 0o600 })

  return {
    env: {
      [definition.delivery.pathEnvVar]: filePath,
    },
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

export async function withDeployablePhaseSecrets<T>(options: {
  deployable: DeployableDefinition
  phase: DeployablePhase
  target: CiTarget
  fn: () => Promise<T>
}): Promise<T> {
  const definitions = (options.deployable.secrets ?? []).filter((secret) => secret.phase === options.phase)

  if (definitions.length === 0) {
    return options.fn()
  }

  const cache: WorkspaceOutputsCache = new Map()
  const previousEnv: Record<string, string | undefined> = {}
  const cleanups: Array<() => Promise<void>> = []

  try {
    for (const definition of definitions) {
      const value = await resolveDefinitionValue(definition, options.target, cache)
      const binding = await createBinding(definition, value)

      if (!binding) {
        continue
      }

      cleanups.push(binding.cleanup)

      for (const [name, envValue] of Object.entries(binding.env)) {
        previousEnv[name] = process.env[name]
        process.env[name] = requiredString(envValue, `secret delivery for ${definition.name}`)
      }
    }

    return await options.fn()
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (typeof value === "string") {
        process.env[name] = value
      } else {
        delete process.env[name]
      }
    }

    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
  }
}

export async function checkDeployableSecrets(options: {
  deployables: DeployableDefinition[]
  target: CiTarget
}): Promise<DeployableSecretCheckEntry[]> {
  const cache: WorkspaceOutputsCache = new Map()
  const entries: DeployableSecretCheckEntry[] = []

  for (const deployable of options.deployables) {
    for (const definition of deployable.secrets ?? []) {
      entries.push(await checkDefinition(definition, deployable, options.target, cache))
    }
  }

  return entries
}

export async function ensureDeployableSecrets(options: {
  deployables: DeployableDefinition[]
  target: CiTarget
}): Promise<DeployableSecretEnsureEntry[]> {
  const cache: WorkspaceOutputsCache = new Map()
  const entries: DeployableSecretEnsureEntry[] = []

  for (const deployable of options.deployables) {
    for (const definition of deployable.secrets ?? []) {
      if (!definition.ensure) {
        entries.push({
          deployable: deployable.name,
          phase: definition.phase,
          secret: definition.name,
          status: "skipped",
          detail: "no ensure strategy configured",
        })
        continue
      }

      try {
        await resolveDefinitionValue(definition, options.target, cache)
        entries.push({
          deployable: deployable.name,
          phase: definition.phase,
          secret: definition.name,
          status: "existing",
          detail: "already resolved",
        })
        continue
      } catch {
        const writeTarget = await resolveDefinitionWriteTarget(definition, options.target, cache)
        if (!writeTarget) {
          throw new Error(`Unable to determine write target for ensured secret ${definition.name}`)
        }

        if (definition.ensure.strategy === "generate-random") {
          const value = generateRandomSecret(definition.ensure.bytes ?? 32)
          await putSecretValueToAws(writeTarget, value)
          entries.push({
            deployable: deployable.name,
            phase: definition.phase,
            secret: definition.name,
            status: "written",
            detail: `wrote generated value to ${writeTarget}`,
          })
        }
      }
    }
  }

  return entries
}

export function assertSecretChecksPassed(entries: DeployableSecretCheckEntry[]): void {
  const failures = entries.filter((entry) => entry.status === "missing")
  if (failures.length === 0) {
    return
  }

  const message = failures
    .map((entry) => `${entry.deployable}:${entry.phase}:${entry.secret} - ${entry.detail}`)
    .join("\n")

  throw new Error(`Required secrets are missing:\n${message}`)
}
