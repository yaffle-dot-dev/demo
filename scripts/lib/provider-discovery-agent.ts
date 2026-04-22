import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { exec } from "./exec"
import { fetchOutputs } from "./outputs"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const PROVIDER_DISCOVERY_AGENT_DIR = resolve(REPO_ROOT, "apps/provider-discovery-agent")
const PROVIDER_DISCOVERY_AGENT_ENTRYPOINT = resolve(PROVIDER_DISCOVERY_AGENT_DIR, "src/index.ts")
const PROVIDER_DISCOVERY_INFRA_WORKSPACE = "apps/provider-discovery-agent/infra"
const PROVIDER_DISCOVERY_DEFAULT_OUTDIR = resolve(REPO_ROOT, "dist/provider-discovery-agent")
const PROVIDER_DISCOVERY_COMPATIBILITY_DATE = "2026-03-23"
const PROVIDER_DISCOVERY_DEFAULT_CALLBACK_TIMEOUT_MS = "8000"
const PROVIDER_DISCOVERY_DEFAULT_MAX_DOCS = "24"
const PROVIDER_DISCOVERY_DEFAULT_AI_MODEL = "@cf/zai-org/glm-4.7-flash"
const PROVIDER_DISCOVERY_DEFAULT_ZONE_NAME = "yaffle.dev"
const PROVIDER_DISCOVERY_HEALTH_ATTEMPTS = 12
const PROVIDER_DISCOVERY_HEALTH_INTERVAL_MS = 5000

export interface BuildProviderDiscoveryAgentOptions {
  outDir?: string
  skipTypecheck?: boolean
}

export type ProviderDiscoveryDeployTarget =
  | { type: "pr"; prNumber: number }
  | { type: "env"; name: string }

export interface ProviderDiscoveryDeployArgs {
  target: ProviderDiscoveryDeployTarget
  wait: boolean
  skipBuild: boolean
  dryRun: boolean
}

interface ProviderDiscoveryInfrastructure {
  environment: string
  workerName: string
  workerHost: string
  workerRoutePattern: string
  workerUrl: string
  aiGatewayId: string
  cloudflareAccountIdSecretId: string
  cloudflareApiTokenSecretId: string
  agentTokenSecretId: string
  callbackSecretSecretId: string
  githubTokenSecretId: string
}

interface ProviderDiscoverySecrets {
  cloudflareAccountId: string
  cloudflareApiToken: string
  agentToken: string
  callbackSecret: string
  githubToken?: string
}

interface TempWranglerFiles {
  tempDir: string
  configPath: string
  secretsPath: string
}

interface LoadSecretValueOptions {
  envKeys: string[]
  secretId: string
  optional?: boolean
}

function getRequiredOutput(
  outputs: Record<string, unknown>,
  key: string,
  workspace: string,
): string {
  const value = outputs[key]

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${workspace} must export ${key}`)
  }

  return value.trim()
}

function parsePrNumber(value: string): number {
  const prNumber = Number.parseInt(value, 10)

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${value}`)
  }

  return prNumber
}

async function getCurrentBranch(): Promise<string> {
  const branch = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: REPO_ROOT,
    quiet: true,
  })

  return branch.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

function renderWranglerDeployConfig(infra: ProviderDiscoveryInfrastructure): string {
  const callbackTimeoutMs = process.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_TIMEOUT_MS?.trim()
    || PROVIDER_DISCOVERY_DEFAULT_CALLBACK_TIMEOUT_MS
  const maxDocs = process.env.YAFFLE_PROVIDER_DISCOVERY_MAX_DOCS?.trim()
    || PROVIDER_DISCOVERY_DEFAULT_MAX_DOCS
  const aiModel = process.env.YAFFLE_PROVIDER_DISCOVERY_AI_MODEL?.trim()
    || PROVIDER_DISCOVERY_DEFAULT_AI_MODEL
  const aiGatewayId = process.env.YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID?.trim()
    || infra.aiGatewayId

  return [
    `name = ${JSON.stringify(infra.workerName)}`,
    `main = ${JSON.stringify(PROVIDER_DISCOVERY_AGENT_ENTRYPOINT)}`,
    `compatibility_date = ${JSON.stringify(PROVIDER_DISCOVERY_COMPATIBILITY_DATE)}`,
    'compatibility_flags = ["nodejs_compat"]',
    "",
    "[observability]",
    "enabled = true",
    "",
    "[observability.logs]",
    "enabled = true",
    "invocation_logs = true",
    "",
    "[ai]",
    'binding = "AI"',
    "",
    "[[durable_objects.bindings]]",
    'name = "ProviderDiscoveryAgent"',
    'class_name = "ProviderDiscoveryAgent"',
    "",
    "[[migrations]]",
    'tag = "v1"',
    'new_sqlite_classes = ["ProviderDiscoveryAgent"]',
    "",
    "[[routes]]",
    `pattern = ${JSON.stringify(infra.workerRoutePattern)}`,
    `zone_name = ${JSON.stringify(PROVIDER_DISCOVERY_DEFAULT_ZONE_NAME)}`,
    "",
    "[vars]",
    `YAFFLE_PROVIDER_DISCOVERY_CALLBACK_TIMEOUT_MS = ${JSON.stringify(callbackTimeoutMs)}`,
    `YAFFLE_PROVIDER_DISCOVERY_MAX_DOCS = ${JSON.stringify(maxDocs)}`,
    `YAFFLE_PROVIDER_DISCOVERY_AI_MODEL = ${JSON.stringify(aiModel)}`,
    `YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID = ${JSON.stringify(aiGatewayId)}`,
    "",
  ].join("\n")
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
      cwd: REPO_ROOT,
      quiet: true,
    },
  )

  return value.trim()
}

async function loadSecretValue(options: LoadSecretValueOptions): Promise<string | undefined> {
  for (const envKey of options.envKeys) {
    const value = process.env[envKey]?.trim()
    if (value) {
      return value
    }
  }

  try {
    const value = await getSecretValueFromAws(options.secretId)

    if (value && value !== "None" && value !== "null") {
      return value
    }
  } catch (error) {
    if (options.optional) {
      return undefined
    }

    throw new Error(
      `Failed to load required secret ${options.secretId}. `
      + `Set ${options.envKeys.join(" or ")} or ensure AWS access is configured.`,
      { cause: error },
    )
  }

  if (options.optional) {
    return undefined
  }

  throw new Error(
    `Required secret ${options.secretId} is empty. `
    + `Set ${options.envKeys.join(" or ")} or populate the secret value in AWS Secrets Manager.`,
  )
}

async function resolveProviderDiscoverySecrets(
  infra: ProviderDiscoveryInfrastructure,
): Promise<ProviderDiscoverySecrets> {
  const [cloudflareAccountId, cloudflareApiToken, agentToken, callbackSecret, githubToken] = await Promise.all([
    loadSecretValue({
      envKeys: ["CLOUDFLARE_ACCOUNT_ID"],
      secretId: infra.cloudflareAccountIdSecretId,
    }),
    loadSecretValue({
      envKeys: ["CLOUDFLARE_API_TOKEN"],
      secretId: infra.cloudflareApiTokenSecretId,
    }),
    loadSecretValue({
      envKeys: ["YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN"],
      secretId: infra.agentTokenSecretId,
    }),
    loadSecretValue({
      envKeys: ["YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET"],
      secretId: infra.callbackSecretSecretId,
    }),
    loadSecretValue({
      envKeys: ["GITHUB_TOKEN", "GITHUB_RESEARCH_TOKEN"],
      secretId: infra.githubTokenSecretId,
      optional: true,
    }),
  ])

  return {
    cloudflareAccountId: cloudflareAccountId ?? "",
    cloudflareApiToken: cloudflareApiToken ?? "",
    agentToken: agentToken ?? "",
    callbackSecret: callbackSecret ?? "",
    ...(githubToken ? { githubToken } : {}),
  }
}

async function writeTempWranglerFiles(
  infra: ProviderDiscoveryInfrastructure,
  secrets: ProviderDiscoverySecrets,
): Promise<TempWranglerFiles> {
  const tempDir = await mkdtemp(join(tmpdir(), "yaffle-provider-discovery-agent-"))
  const configPath = join(tempDir, "wrangler.deploy.toml")
  const secretsPath = join(tempDir, "wrangler.secrets.json")

  const runtimeSecrets: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: secrets.cloudflareAccountId,
    YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN: secrets.agentToken,
    YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET: secrets.callbackSecret,
  }

  if (secrets.githubToken) {
    runtimeSecrets.GITHUB_TOKEN = secrets.githubToken
  }

  await writeFile(configPath, renderWranglerDeployConfig(infra), "utf8")
  await writeFile(secretsPath, JSON.stringify(runtimeSecrets, null, 2), "utf8")

  return {
    tempDir,
    configPath,
    secretsPath,
  }
}

export function getProviderDiscoveryDefaultOutDir(): string {
  return PROVIDER_DISCOVERY_DEFAULT_OUTDIR
}

export async function buildProviderDiscoveryAgentBundle(
  options: BuildProviderDiscoveryAgentOptions = {},
): Promise<string> {
  const outDir = options.outDir ?? PROVIDER_DISCOVERY_DEFAULT_OUTDIR

  await mkdir(outDir, { recursive: true })

  if (!options.skipTypecheck) {
    console.log("Typechecking provider discovery agent...")
    await exec(["bun", "run", "--filter=@yaffle/provider-discovery-agent", "typecheck"], {
      cwd: REPO_ROOT,
    })
  }

  console.log(`Bundling provider discovery agent to ${outDir}`)
  await exec(
    [
      "bunx",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      outDir,
      "--config",
      "wrangler.toml",
    ],
    {
      cwd: PROVIDER_DISCOVERY_AGENT_DIR,
    },
  )

  return outDir
}

export function formatProviderDiscoveryDeployTarget(target: ProviderDiscoveryDeployTarget): string {
  return target.type === "pr" ? `PR #${target.prNumber}` : `env: ${target.name}`
}

export async function parseProviderDiscoveryDeployArgs(
  scriptName: string,
): Promise<ProviderDiscoveryDeployArgs> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      env: { type: "string" },
      "no-wait": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: ${scriptName} [options]

Options:
  --pr <number>     Deploy the PR preview worker
  --env <name>      Deploy to a named environment (main, staging, etc.)
  --no-wait         Don't wait for Yaffle infrastructure outputs
  --skip-build      Skip the local bundle/typecheck preflight
  --dry-run         Show what would be deployed without deploying
  --help            Show this help

If neither --pr nor --env is specified, the script deploys main/master automatically.
`)
    process.exit(0)
  }

  let target: ProviderDiscoveryDeployTarget

  if (values.pr) {
    target = { type: "pr", prNumber: parsePrNumber(values.pr) }
  } else if (values.env) {
    target = { type: "env", name: values.env }
  } else {
    const branch = await getCurrentBranch()

    if (branch === "main" || branch === "master") {
      target = { type: "env", name: branch }
    } else {
      throw new Error(
        `On branch '${branch}'. Specify --pr <number> or --env <name> (only main/master auto-deploy without flags)`,
      )
    }
  }

  return {
    target,
    wait: !values["no-wait"],
    skipBuild: values["skip-build"] ?? false,
    dryRun: values["dry-run"] ?? false,
  }
}

export async function loadProviderDiscoveryInfrastructure(
  target: ProviderDiscoveryDeployTarget,
  wait: boolean,
): Promise<ProviderDiscoveryInfrastructure> {
  const previousCwd = process.cwd()
  process.chdir(REPO_ROOT)

  try {
    const outputs = target.type === "pr"
      ? await fetchOutputs({
        workspace: PROVIDER_DISCOVERY_INFRA_WORKSPACE,
        prNumber: target.prNumber,
        wait,
        waitTimeout: 600,
      })
      : await fetchOutputs({
        workspace: PROVIDER_DISCOVERY_INFRA_WORKSPACE,
        environment: target.name,
        wait,
        waitTimeout: 600,
      })

    return {
      environment: getRequiredOutput(outputs, "environment", PROVIDER_DISCOVERY_INFRA_WORKSPACE),
      workerName: getRequiredOutput(outputs, "worker_name", PROVIDER_DISCOVERY_INFRA_WORKSPACE),
      workerHost: getRequiredOutput(outputs, "worker_host", PROVIDER_DISCOVERY_INFRA_WORKSPACE),
      workerRoutePattern: getRequiredOutput(
        outputs,
        "worker_route_pattern",
        PROVIDER_DISCOVERY_INFRA_WORKSPACE,
      ),
      workerUrl: getRequiredOutput(outputs, "worker_url", PROVIDER_DISCOVERY_INFRA_WORKSPACE),
      aiGatewayId: getRequiredOutput(outputs, "ai_gateway_id", PROVIDER_DISCOVERY_INFRA_WORKSPACE),
      cloudflareAccountIdSecretId: getRequiredOutput(
        outputs,
        "cloudflare_account_id_secret_id",
        PROVIDER_DISCOVERY_INFRA_WORKSPACE,
      ),
      cloudflareApiTokenSecretId: getRequiredOutput(
        outputs,
        "cloudflare_api_token_secret_id",
        PROVIDER_DISCOVERY_INFRA_WORKSPACE,
      ),
      agentTokenSecretId: getRequiredOutput(
        outputs,
        "agent_token_secret_id",
        PROVIDER_DISCOVERY_INFRA_WORKSPACE,
      ),
      callbackSecretSecretId: getRequiredOutput(
        outputs,
        "callback_secret_secret_id",
        PROVIDER_DISCOVERY_INFRA_WORKSPACE,
      ),
      githubTokenSecretId: getRequiredOutput(
        outputs,
        "github_token_secret_id",
        PROVIDER_DISCOVERY_INFRA_WORKSPACE,
      ),
    }
  } finally {
    process.chdir(previousCwd)
  }
}

export async function waitForProviderDiscoveryHealth(workerUrl: string): Promise<void> {
  const healthUrl = new URL("/health", workerUrl).toString()

  for (let attempt = 1; attempt <= PROVIDER_DISCOVERY_HEALTH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl)

      if (response.ok) {
        console.log(`Health check passed: ${healthUrl}`)
        return
      }

      console.log(
        `Health check attempt ${attempt}/${PROVIDER_DISCOVERY_HEALTH_ATTEMPTS} returned ${response.status}`,
      )
    } catch (error) {
      console.log(
        `Health check attempt ${attempt}/${PROVIDER_DISCOVERY_HEALTH_ATTEMPTS} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    if (attempt < PROVIDER_DISCOVERY_HEALTH_ATTEMPTS) {
      await sleep(PROVIDER_DISCOVERY_HEALTH_INTERVAL_MS)
    }
  }

  throw new Error(`Provider discovery agent health check failed for ${healthUrl}`)
}

export async function deployProviderDiscoveryAgent(options: ProviderDiscoveryDeployArgs): Promise<void> {
  const targetLabel = formatProviderDiscoveryDeployTarget(options.target)

  console.log("=== Provider Discovery Agent Deploy ===")
  console.log(`Target: ${targetLabel}`)
  if (options.dryRun) {
    console.log("(dry-run mode)")
  }

  if (!options.skipBuild) {
    await buildProviderDiscoveryAgentBundle()
  } else {
    console.log("\nSkipping build (--skip-build)")
  }

  const infra = await loadProviderDiscoveryInfrastructure(options.target, options.wait)

  console.log("\nInfrastructure:")
  console.log(`  Environment: ${infra.environment}`)
  console.log(`  Worker: ${infra.workerName}`)
  console.log(`  Host: ${infra.workerHost}`)
  console.log(`  Route: ${infra.workerRoutePattern}`)
  console.log(`  URL: ${infra.workerUrl}`)

  if (options.dryRun) {
    console.log("\n[dry-run] Would deploy the provider discovery agent with target-specific infra outputs")
    return
  }

  const secrets = await resolveProviderDiscoverySecrets(infra)
  const tempFiles = await writeTempWranglerFiles(infra, secrets)

  try {
    await exec(
      [
        "bunx",
        "wrangler",
        "deploy",
        "--config",
        tempFiles.configPath,
        "--secrets-file",
        tempFiles.secretsPath,
      ],
      {
        cwd: PROVIDER_DISCOVERY_AGENT_DIR,
        env: {
          CLOUDFLARE_ACCOUNT_ID: secrets.cloudflareAccountId,
          CLOUDFLARE_API_TOKEN: secrets.cloudflareApiToken,
        },
      },
    )
  } finally {
    await rm(tempFiles.tempDir, { recursive: true, force: true })
  }

  await waitForProviderDiscoveryHealth(infra.workerUrl)

  console.log("\n=== Deploy Complete ===")
  console.log(`Worker: ${infra.workerUrl}`)
}
