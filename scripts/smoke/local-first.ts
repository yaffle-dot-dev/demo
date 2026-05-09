import type { ChildProcess } from "node:child_process"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, cp, access, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { constants as fsConstants } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import type { Readable } from "node:stream"
import { writeFile } from "node:fs/promises"
import { GenericContainer, Wait } from "testcontainers"

const REPO_ROOT = "/Users/alexlauni/Code/yaffle/root"
const FIXTURE_NAME = "converge-local-module-source"
const FIXTURE_SOURCE = join(REPO_ROOT, "testdata/engine/repos", FIXTURE_NAME)
const FEATURE_TOKEN = `smoke-${crypto.randomUUID()}`
const POSTGRES_DB = "yaffle_local_first_smoke"
const POSTGRES_USER = "postgres"
const POSTGRES_PASSWORD = "postgres"

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true"
configureContainerRuntimeEnv()

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "yaffle-local-first-smoke-"))
  const fixtureRoot = join(tempRoot, "fixture")
  const homeDir = join(tempRoot, "home")
  await mkdir(homeDir, { recursive: true })
  await cp(FIXTURE_SOURCE, fixtureRoot, { recursive: true })
  await mkdir(join(fixtureRoot, ".git"), { recursive: true })
  await writeFile(
    join(fixtureRoot, ".git/config"),
    `[remote "origin"]\n  url = https://github.com/test-org/fixture.git\n`,
  )

  console.log(`[smoke] temp root: ${tempRoot}`)

  const postgres = await new GenericContainer("docker.io/postgres:17-alpine")
    .withEnvironment({
      POSTGRES_DB,
      POSTGRES_USER,
      POSTGRES_PASSWORD,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections"))
    .start()

  const controlPlanePort = await reservePort()
  const proxyPort = await reservePort()
  const caddyAdminPort = await reservePort()
  const databaseUrl = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${postgres.getMappedPort(5432)}/${POSTGRES_DB}`
  const controlPlaneUrl = `http://localhost:${controlPlanePort}`
  const moduleApiUrl = `https://yaffle.localhost:${proxyPort}`
  const publicApiUrl = moduleApiUrl

  console.log(`[smoke] postgres: ${databaseUrl.replace(POSTGRES_PASSWORD, "***")}`)
  console.log(`[smoke] control plane target: ${controlPlaneUrl}`)

  const controlPlaneEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    YAFFLE_PUBLIC_API_URL: publicApiUrl,
    BETTER_AUTH_URL: publicApiUrl,
    TRUSTED_ORIGINS: `${publicApiUrl},${controlPlaneUrl}`,
    BETTER_AUTH_SECRET: "smoke-test-better-auth-secret-which-is-long-enough",
    YAFFLE_AUTH_MODE: "dev",
    YAFFLE_PROCESS_ROLE: "api",
    YAFFLE_DISABLE_SCHEDULER: "true",
    YAFFLE_LOCAL_FIRST_FEATURE_TOKEN: FEATURE_TOKEN,
    YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS: "999",
    YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS: "999999",
    YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS: "999",
    HOST: "127.0.0.1",
    PORT: String(controlPlanePort),
  }

  let controlPlane: ChildProcess | undefined
  let caddy: ChildProcess | undefined
  try {
    await runCommand(["caddy", "version"], REPO_ROOT, process.env, "check caddy")

    await runCommand(
      ["vp", "run", "@yaffle/control-plane#db:migrate"],
      REPO_ROOT,
      controlPlaneEnv,
      "database migrations",
    )

    controlPlane = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: controlPlaneEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const stdoutBuffer = pipeSubprocessOutput(controlPlane.stdout, "[control-plane] ")
    const stderrBuffer = pipeSubprocessOutput(controlPlane.stderr, "[control-plane] ")

    await waitForHttp(`${controlPlaneUrl}/api/health`, 30_000)
    console.log("[smoke] control plane is healthy")

    const caddyConfigPath = join(tempRoot, "Caddyfile")
    await writeFile(
      caddyConfigPath,
      `{
  admin 127.0.0.1:${caddyAdminPort}
  local_certs
  servers {
    protocols h1
  }
}

https://yaffle.localhost:${proxyPort} {
  reverse_proxy 127.0.0.1:${controlPlanePort}
}
`,
    )

    caddy = spawn("caddy", ["run", "--config", caddyConfigPath], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    pipeSubprocessOutput(caddy.stdout, "[caddy] ")
    pipeSubprocessOutput(caddy.stderr, "[caddy] ")

    await waitForHttps(`${moduleApiUrl}/api/health`, 30_000)
    console.log(`[smoke] Caddy TLS proxy is healthy at ${moduleApiUrl}`)

    await runCommand(["cargo", "build", "-p", "yaffle-cli"], REPO_ROOT, process.env, "build yaffle-cli")

    const cliEnv = {
      ...process.env,
      HOME: homeDir,
      YAFFLE_MODULE_API_HOST: moduleApiUrl,
      YAFFLE_LOCAL_FIRST_FEATURE_TOKEN: FEATURE_TOKEN,
    }
    const yaffleBinary = join(REPO_ROOT, "target/debug/yaffle")

    await runCommand(
      [yaffleBinary, "converge", "--env", "main", "--json"],
      fixtureRoot,
      cliEnv,
      "yaffle converge",
    )

    const outputsStdout = await runCommand(
      [yaffleBinary, "outputs", "--env", "main", "--workspace", "apps/web/infra", "--json"],
      fixtureRoot,
      cliEnv,
      "yaffle outputs",
      true,
    )
    const outputsResponse = JSON.parse(outputsStdout) as {
      outputs: Record<string, { value: unknown }>
    }
    if (outputsResponse.outputs.shared_message?.value !== "hello-from-shared") {
      throw new Error("expected shared_message output from yaffle outputs")
    }
    console.log("[smoke] yaffle outputs returned hosted downstream value")

    const loginStdout = await runCommand(
      [yaffleBinary, "tf", "login", "--env", "main", "--workspace", "apps/web/infra"],
      fixtureRoot,
      cliEnv,
      "yaffle tf login",
      true,
    )
    const shellEnv = parseShellExports(loginStdout)
    const tfCliConfigFile = shellEnv.TF_CLI_CONFIG_FILE
    if (!tfCliConfigFile) {
      throw new Error("yaffle tf login did not emit TF_CLI_CONFIG_FILE")
    }
    await access(tfCliConfigFile, fsConstants.F_OK)
    console.log(`[smoke] tf login emitted scoped CLI config: ${tfCliConfigFile}`)

    const tofuEnv = {
      ...cliEnv,
      ...shellEnv,
      TF_IN_AUTOMATION: "1",
      TOFU_IN_AUTOMATION: "1",
    }

    await runCommand(
      ["tofu", "init", "-input=false", "-no-color"],
      join(fixtureRoot, "apps/web/infra"),
      tofuEnv,
      "raw tofu init",
    )
    console.log("[smoke] raw tofu init succeeded with hosted output-module transport")

    if (!stdoutBuffer.join("").includes("Anonymous") && !stderrBuffer.join("").includes("Anonymous")) {
      console.log("[smoke] note: control-plane logs did not contain explicit anonymous-session text")
    }

    console.log("[smoke] local-first smoke test passed")
  } finally {
    if (caddy) {
      caddy.kill("SIGTERM")
      await waitForExit(caddy).catch(() => {})
    }
    if (controlPlane) {
      controlPlane.kill("SIGTERM")
      await waitForExit(controlPlane).catch(() => {})
    }

    await postgres.stop().catch(() => {})
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

function configureContainerRuntimeEnv(): void {
  if (process.env.DOCKER_HOST) {
    return
  }

  const inspect = spawnSync("podman", ["machine", "inspect", "podman-machine-default"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if ((inspect.status ?? 1) !== 0) {
    return
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(inspect.stdout)) as Array<{
      ConnectionInfo?: { PodmanSocket?: { Path?: string } }
    }>
    const socketPath = parsed[0]?.ConnectionInfo?.PodmanSocket?.Path
    if (socketPath && existsSync(socketPath)) {
      process.env.DOCKER_HOST = `unix://${socketPath}`
      console.log(`[smoke] using podman socket via DOCKER_HOST=${process.env.DOCKER_HOST}`)
    }
  } catch {
    // Ignore podman inspection parsing failures and let testcontainers try its defaults.
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("could not reserve local port"))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolvePort(port)
        }
      })
    })
  })
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  let lastError: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = new Error(`status ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await sleep(500)
  }

  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`)
}

async function waitForHttps(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  let lastError: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      await runCommand(
        ["curl", "--silent", "--show-error", "--fail", url],
        REPO_ROOT,
        process.env,
        `probe ${url}`,
      )
      return
    } catch (error) {
      lastError = error
    }

    await sleep(500)
  }

  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`)
}

async function runCommand(
  cmd: string[],
  cwd: string,
  envVars: NodeJS.ProcessEnv | undefined,
  label: string,
  captureStdout = false,
): Promise<string> {
  console.log(`[smoke] ${label}: ${cmd.join(" ")}`)
  const proc = spawn(cmd[0]!, cmd.slice(1), {
    cwd,
    env: envVars,
    stdio: ["ignore", captureStdout ? "pipe" : "inherit", "pipe"],
  })

  let stdout = ""
  if (captureStdout && proc.stdout) {
    stdout = await streamToString(proc.stdout)
  }
  const stderr = proc.stderr ? await streamToString(proc.stderr) : ""
  const exitCode = await waitForExit(proc)
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}\n${stderr}`)
  }

  return stdout
}

function pipeSubprocessOutput(stream: Readable | null, prefix: string): string[] {
  const buffer: string[] = []
  if (!stream) {
    return buffer
  }

  streamToString(stream, (chunk) => {
    buffer.push(chunk)
    process.stdout.write(prefix + chunk)
  }).catch(() => {})
  return buffer
}

async function streamToString(
  stream: Readable,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  let output = ""

  stream.setEncoding("utf8")
  for await (const value of stream) {
    const chunk = typeof value === "string" ? value : value.toString("utf8")
    output += chunk
    onChunk?.(chunk)
  }
  return output
}

async function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    proc.on("error", reject)
    proc.on("close", (code) => {
      resolvePromise(code ?? 1)
    })
  })
}

function parseShellExports(stdout: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of stdout.split("\n")) {
    const match = line.match(/^export\s+([A-Za-z0-9_]+)=(.*)$/)
    if (!match) continue
    values[match[1]] = unquoteShellValue(match[2])
  }
  return values
}

function unquoteShellValue(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'"'"'/g, "'")
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

await main().catch((error) => {
  console.error("[smoke] local-first smoke test failed")
  console.error(error)
  process.exit(1)
})
