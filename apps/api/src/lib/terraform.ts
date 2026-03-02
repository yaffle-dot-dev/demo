import { join } from "node:path"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"

import type { RunType, TerraformResult } from "@yaffle/shared"

import { logger, tracer } from "./telemetry.ts"

/** Resolve the terraform/tofu binary path. */
function getTfBinary(): string {
  return process.env.YAFFLE_TF_BINARY ?? "terraform"
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (!stream) return ""
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let output = ""

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    output += chunk
    onChunk?.(chunk)
  }

  return output
}

interface TfExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Execute a terraform/tofu command as a subprocess.
 */
async function execTf(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void,
): Promise<TfExecResult> {
  const binary = getTfBinary()
  const subcommand = args[0] ?? "unknown"

  return tracer.startActiveSpan(`tf.${subcommand}`, async (span) => {
    span.setAttributes({
      "tf.binary": binary,
      "tf.args": args.join(" "),
      "tf.cwd": cwd,
    })

    logger.debug(`${binary} ${args.join(" ")}`, { "tf.cwd": cwd })

    const proc = Bun.spawn([binary, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" },
    })

    const stdoutPromise = readStream(proc.stdout, (chunk) => {
      onOutput?.(sanitizeOutput(chunk), "stdout")
    })
    const stderrPromise = readStream(proc.stderr, (chunk) => {
      onOutput?.(sanitizeOutput(chunk), "stderr")
    })

    const exitCode = await proc.exited
    const stdout = await stdoutPromise
    const stderr = await stderrPromise

    if (stderr) {
      for (const line of stderr.split("\n").filter(Boolean)) {
        logger.debug(`[tf:stderr] ${line}`)
      }
    }

    span.setAttributes({ "tf.exit_code": exitCode })
    span.end()

    return { exitCode, stdout, stderr }
  })
}

/**
 * Run `terraform init` in the given directory.
 */
export async function tfInit(
  workDir: string,
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void,
): Promise<TfExecResult> {
  return execTf(["init", "-input=false", "-no-color"], workDir, undefined, onOutput)
}

/**
 * Run `terraform plan`, save the plan file, and extract the JSON plan.
 * Returns the human-readable plan output and structured JSON.
 */
export async function tfPlan(
  workDir: string,
  variables?: Record<string, string>,
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void,
): Promise<{ output: string; planJson: unknown; summary: string }> {
  // Write variables file if provided
  if (variables && Object.keys(variables).length > 0) {
    await writeFile(
      join(workDir, "terraform.tfvars.json"),
      JSON.stringify(variables, null, 2),
    )
  }

  const planFile = join(workDir, "tfplan")

  const result = await execTf(
    ["plan", "-out=tfplan", "-input=false", "-no-color", "-detailed-exitcode"],
    workDir,
    undefined,
    onOutput,
  )

  // Exit code 0 = no changes, 1 = error, 2 = changes present
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new TerraformError("plan", result)
  }

  const output = result.stdout

  // Extract JSON plan
  let planJson: unknown = null
  if (existsSync(planFile)) {
    const showResult = await execTf(["show", "-json", "-no-color", "tfplan"], workDir)
    if (showResult.exitCode === 0) {
      try {
        planJson = JSON.parse(showResult.stdout)
      } catch {
        logger.warn("failed to parse plan JSON")
      }
    }
  }

  const summary = parsePlanSummary(output)

  return { output, planJson, summary }
}

/**
 * Run `terraform apply` with auto-approve.
 */
export async function tfApply(
  workDir: string,
  variables?: Record<string, string>,
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void,
): Promise<{ output: string; outputs: Record<string, unknown> }> {
  if (variables && Object.keys(variables).length > 0) {
    await writeFile(
      join(workDir, "terraform.tfvars.json"),
      JSON.stringify(variables, null, 2),
    )
  }

  const result = await execTf(
    ["apply", "-auto-approve", "-input=false", "-no-color"],
    workDir,
    undefined,
    onOutput,
  )

  if (result.exitCode !== 0) {
    throw new TerraformError("apply", result)
  }

  // Fetch outputs
  const outputResult = await execTf(["output", "-json", "-no-color"], workDir)
  let outputs: Record<string, unknown> = {}
  if (outputResult.exitCode === 0 && outputResult.stdout.trim()) {
    try {
      outputs = JSON.parse(outputResult.stdout)
    } catch {
      logger.warn("failed to parse outputs JSON")
    }
  }

  return { output: result.stdout, outputs }
}

/**
 * Run `terraform destroy` with auto-approve.
 */
export async function tfDestroy(
  workDir: string,
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void,
): Promise<{ output: string }> {
  const result = await execTf(
    ["destroy", "-auto-approve", "-input=false", "-no-color"],
    workDir,
    undefined,
    onOutput,
  )

  if (result.exitCode !== 0) {
    throw new TerraformError("destroy", result)
  }

  return { output: result.stdout }
}

/**
 * High-level: run a full terraform operation (init + command).
 * This is what the webhook handler calls.
 */
export async function runTerraform(opts: {
  workDir: string
  command: RunType
  variables?: Record<string, string>
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void
}): Promise<TerraformResult> {
  const start = Date.now()

  try {
    // Always init first
    const initResult = await tfInit(opts.workDir, opts.onOutput)
    if (initResult.exitCode !== 0) {
      return {
        success: false,
        command: opts.command,
        output: sanitizeOutput(initResult.stdout),
        errorMessage: sanitizeOutput(`terraform init failed: ${initResult.stderr}`),
        durationMs: Date.now() - start,
      }
    }

    switch (opts.command) {
      case "plan": {
        const { output, planJson, summary } = await tfPlan(
          opts.workDir,
          opts.variables,
          opts.onOutput,
        )
        return {
          success: true,
          command: "plan",
          output: sanitizeOutput(output),
          planJson,
          planSummary: summary,
          durationMs: Date.now() - start,
        }
      }

      case "apply": {
        const { output, outputs } = await tfApply(opts.workDir, opts.variables, opts.onOutput)
        return {
          success: true,
          command: "apply",
          output: sanitizeOutput(output),
          outputs,
          durationMs: Date.now() - start,
        }
      }

      case "destroy": {
        const { output } = await tfDestroy(opts.workDir, opts.onOutput)
        return {
          success: true,
          command: "destroy",
          output: sanitizeOutput(output),
          durationMs: Date.now() - start,
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const output = err instanceof TerraformError ? err.output : ""
    return {
      success: false,
      command: opts.command,
      output: sanitizeOutput(output),
      errorMessage: sanitizeOutput(msg),
      durationMs: Date.now() - start,
    }
  }
}

/**
 * Sanitize raw CLI output before it reaches users.
 * Replaces implementation-specific references (OpenTofu, tofu, Terraform)
 * with "Yaffle" so we don't leak engine details.
 */
export function sanitizeOutput(raw: string): string {
  return raw
    .replaceAll("OpenTofu", "Yaffle")
    .replaceAll("opentofu.org", "yaffle.dev")
    .replace(/\btofu\b/g, "yaffle")
    .replaceAll("Terraform", "Yaffle")
    .replace(/\bterraform\b/g, "yaffle")
}

/**
 * Parse the plan summary from terraform output.
 * Looks for lines like "Plan: 3 to add, 1 to change, 0 to destroy."
 * or "No changes. Infrastructure is up-to-date."
 */
export function parsePlanSummary(output: string): string {
  // Match "Plan: X to add, Y to change, Z to destroy."
  const planMatch = output.match(
    /Plan:\s*(\d+)\s*to add,\s*(\d+)\s*to change,\s*(\d+)\s*to destroy/,
  )
  if (planMatch) {
    return `+${planMatch[1]}, ~${planMatch[2]}, -${planMatch[3]}`
  }

  // Match "No changes"
  if (/No changes/.test(output)) {
    return "no changes"
  }

  return "unknown"
}

class TerraformError extends Error {
  public readonly output: string

  constructor(command: string, result: TfExecResult) {
    const msg = `terraform ${command} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`
    super(msg)
    this.name = "TerraformError"
    this.output = result.stdout
  }
}
