import type { Subprocess } from "bun"

/**
 * Terraform Executor
 *
 * Executes terraform commands via shell and parses output.
 */

import { join } from "node:path"
import { writeFile, mkdir } from "node:fs/promises"

import type { ExecutionContext } from "./api-client.ts"
import { ResourceSpanParser, type ResourceSpanEvent } from "./span-parser.ts"

export interface TerraformResult {
  success: boolean
  command: "plan" | "apply" | "destroy"
  output: string
  hasChanges?: boolean
  planSummary?: string
  planJson?: unknown
  planFilePath?: string
  outputs?: Record<string, unknown>
  errorMessage?: string
  durationMs: number
}

export interface ExecutorOptions {
  /** Working directory (extracted workspace path) */
  workDir: string
  /** Execution context from API */
  context: ExecutionContext
  /** Callback for streaming output */
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void
  /** Callback when the active tofu subprocess changes */
  onProcess?: (proc: Subprocess | null) => void
  /** Callback for resource span events parsed from stdout */
  onSpanEvent?: (event: ResourceSpanEvent) => void
  /** TRACEPARENT value for OTel trace correlation */
  traceparent?: string
}

/**
 * Execute terraform command.
 */
export async function executeTerraform(opts: ExecutorOptions): Promise<TerraformResult> {
  const { workDir, context, onOutput, onProcess, onSpanEvent, traceparent } = opts
  const startTime = Date.now()

  // Wrap onOutput to also feed the span parser
  let wrappedOnOutput = onOutput
  let spanParser: ResourceSpanParser | undefined
  if (onSpanEvent) {
    spanParser = new ResourceSpanParser(onSpanEvent)
    wrappedOnOutput = (chunk: string, source: "stdout" | "stderr") => {
      onOutput?.(chunk, source)
      // Only parse stdout — stderr is terraform diagnostics, not resource lifecycle
      if (source === "stdout") {
        spanParser!.feed(chunk)
      }
    }
  }

  try {
    // Configure backend
    const backendEnv = await configureBackend(workDir, context)
    const executionEnv = context.executionEnv ?? {}
    const combinedEnv: Record<string, string> = {
      ...executionEnv,
      ...backendEnv,
      ...(traceparent ? { TRACEPARENT: traceparent } : {}),
    }

    // Configure variables
    await configureVariables(workDir, context)

    // Run tofu init
      const initResult = await runCommand(
        workDir,
        ["tofu", "init", "-input=false"],
        wrappedOnOutput,
        combinedEnv,
        onProcess,
      )
    if (!initResult.success) {
      return {
        success: false,
        command: context.command,
        output: initResult.output,
        errorMessage: `tofu init failed: ${initResult.output}`,
        durationMs: Date.now() - startTime,
      }
    }

    // Execute the main command
    let result: CommandResult
    let planJson: unknown
    let planSummary: string | undefined
    let outputs: Record<string, unknown> | undefined

    switch (context.command) {
      case "plan": {
        result = await runCommand(
          workDir,
          ["tofu", "plan", "-input=false", "-out=tfplan", "-detailed-exitcode"],
          wrappedOnOutput,
          combinedEnv,
          onProcess,
          [0, 2],
        )

        if (result.success) {
          // Generate plan JSON for structured output
          const showResult = await runCommand(
            workDir,
            ["tofu", "show", "-json", "tfplan"],
            undefined, // Don't stream this output
            combinedEnv,
            onProcess,
          )
          if (showResult.success) {
            try {
              planJson = JSON.parse(showResult.stdout)
            } catch {
              // Ignore JSON parse errors
            }
          }

          // Parse plan summary from output
          planSummary = parsePlanSummary(result.output)
        }
        break
      }

      case "apply": {
        // If a saved plan file URL is provided, download it and apply from plan
        const planFilePath = join(workDir, "tfplan")
        let hasPlanFile = false

        if (context.planFileUrl) {
          try {
            const planResponse = await fetch(context.planFileUrl)
            if (planResponse.ok) {
              const planData = await planResponse.arrayBuffer()
              await writeFile(planFilePath, Buffer.from(planData))
              hasPlanFile = true
            }
          } catch {
            // Fall back to re-planning via auto-approve
          }
        }

        if (hasPlanFile) {
          // Apply from saved plan — no refresh, no re-plan
          result = await runCommand(
            workDir,
            ["tofu", "apply", "-input=false", planFilePath],
            wrappedOnOutput,
            combinedEnv,
            onProcess,
          )
        } else {
          // Fallback: re-plan and apply (old behavior)
          result = await runCommand(
            workDir,
            ["tofu", "apply", "-input=false", "-auto-approve"],
            wrappedOnOutput,
            combinedEnv,
            onProcess,
          )
        }

        if (result.success) {
          // Capture outputs
          const outputResult = await runCommand(
            workDir,
            ["tofu", "output", "-json"],
            undefined,
            combinedEnv,
            onProcess,
          )
          if (outputResult.success) {
            try {
              outputs = JSON.parse(outputResult.stdout)
            } catch {
              // Ignore JSON parse errors
            }
          }
        }
        break
      }

      case "destroy": {
        result = await runCommand(
          workDir,
          ["tofu", "destroy", "-input=false", "-auto-approve"],
          wrappedOnOutput,
          combinedEnv,
          onProcess,
        )
        break
      }

      default:
        throw new Error(`Unknown command: ${context.command}`)
    }

    // Flush any remaining buffered lines in the span parser
    spanParser?.flush()

    return {
      success: result.success,
      command: context.command,
      output: initResult.output + "\n" + result.output,
      hasChanges: context.command === "plan" ? result.exitCode === 2 : undefined,
      planSummary,
      planJson,
      planFilePath: context.command === "plan" && result.success ? join(workDir, "tfplan") : undefined,
      outputs,
      errorMessage: result.success ? undefined : result.output,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      command: context.command,
      output: "",
      errorMessage,
      durationMs: Date.now() - startTime,
    }
  }
}

/**
 * Configure backend override file.
 */
async function configureBackend(
  workDir: string,
  context: ExecutionContext,
): Promise<Record<string, string>> {
  if (!context.backendConfig) {
    return {}
  }

  const backendContent = `terraform {
  cloud {
    hostname     = "${context.backendConfig.hostname}"
    organization = "${context.backendConfig.organization}"
    
    workspaces {
      name = "${context.backendConfig.workspaceName}"
    }
  }
}
`

  await writeFile(join(workDir, "backend_override.tf"), backendContent)

  // Configure credentials if TFC token is provided
  if (context.tfcToken) {
    const credsDir = join(workDir, ".yaffle")
    await mkdir(credsDir, { recursive: true })

    const credentialHosts = [
      context.backendConfig.hostname,
      ...(context.backendConfig.credentialHosts ?? []),
    ].filter((host, index, hosts) => host.length > 0 && hosts.indexOf(host) === index)

    const credentialsPath = join(credsDir, "credentials.tfrc.json")
    const credsContent = JSON.stringify({
      credentials: Object.fromEntries(
        credentialHosts.map((host) => [host, { token: context.tfcToken }]),
      ),
    })

    await writeFile(credentialsPath, credsContent)

    const envVars: Record<string, string> = {
      TF_CLI_CONFIG_FILE: credentialsPath,
      YAFFLE_TFC_API_HOST: context.backendConfig.hostname,
    }

    for (const host of credentialHosts) {
      envVars[`TF_TOKEN_${host.replace(/[.:]/g, "_")}`] = context.tfcToken
    }

    return envVars
  }

  return {}
}

/**
 * Configure terraform variables file.
 */
async function configureVariables(
  workDir: string,
  context: ExecutionContext,
): Promise<void> {
  if (Object.keys(context.variables).length === 0) {
    return
  }

  const varsContent = JSON.stringify(context.variables, null, 2)
  await writeFile(join(workDir, "terraform.tfvars.json"), varsContent)
}

interface CommandResult {
  success: boolean
  output: string
  stdout: string
  exitCode: number
  timedOut?: boolean
}

/**
 * Run a command and capture output.
 */
async function runCommand(
  workDir: string,
  args: string[],
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void,
  extraEnv: Record<string, string> = {},
  onProcess?: (proc: Subprocess | null) => void,
  successExitCodes: number[] = [0],
  timeoutMs = 20 * 60 * 1000,
): Promise<CommandResult> {
  const proc = Bun.spawn(args, {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...extraEnv,
      // Disable interactive prompts
      TF_INPUT: "false",
      // Force color output for better logs
      TF_CLI_ARGS: "-no-color",
    },
  })
  onProcess?.(proc)

  let output = ""
  let stdout = ""
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      output += `\n[yaffle-runner] command timed out after ${Math.floor(timeoutMs / 1000)}s\n`
      try {
        proc.kill("SIGTERM")
      } catch {
        // ignore termination errors
      }

      setTimeout(() => {
        try {
          proc.kill("SIGKILL")
        } catch {
          // ignore termination errors
        }
      }, 5000)
    }, timeoutMs)
  }

  // Stream stdout
  const stdoutReader = proc.stdout.getReader()
  const stderrReader = proc.stderr.getReader()

  const readStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    source: "stdout" | "stderr",
  ): Promise<void> => {
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value)
      output += chunk
      if (source === "stdout") {
        stdout += chunk
      }

      if (onOutput) {
        onOutput(chunk, source)
      }
    }
  }

  await Promise.all([
    readStream(stdoutReader, "stdout"),
    readStream(stderrReader, "stderr"),
  ])

  const exitCode = await proc.exited
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
  }
  onProcess?.(null)

  return {
    success: successExitCodes.includes(exitCode) && !timedOut,
    output,
    stdout,
    exitCode,
    timedOut,
  }
}

/**
 * Parse plan summary from terraform plan output.
 */
function parsePlanSummary(output: string): string {
  const planMatch = output.match(/Plan:\s*(\d+)\s*to add,\s*(\d+)\s*to change,\s*(\d+)\s*to destroy/i)
  if (planMatch) {
    const [, add, change, destroy] = planMatch
    return `+${add}, ~${change}, -${destroy}`
  }

  // Look for the summary line like "Plan: 2 to add, 0 to change, 0 to destroy."
  // Or "No changes. Your infrastructure matches the configuration."
  const noChangesMatch = output.match(/No changes\./i)
  if (noChangesMatch) {
    return "no changes"
  }

  return "unknown"
}
