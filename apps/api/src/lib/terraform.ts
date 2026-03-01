import { join } from "node:path"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"

import type { RunType, TerraformResult } from "@yaffle/shared"

/** Resolve the terraform/tofu binary path. */
function getTfBinary(): string {
  return process.env.YAFFLE_TF_BINARY ?? "terraform"
}

interface TfExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Execute a terraform/tofu command as a subprocess.
 */
function execTf(args: string[], cwd: string, env?: Record<string, string>): TfExecResult {
  const binary = getTfBinary()
  console.log(`[tf] ${binary} ${args.join(" ")} (cwd: ${cwd})`)

  const result = Bun.spawnSync([binary, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" },
  })

  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()

  if (stderr) {
    // tofu/terraform writes progress to stderr even on success, log it
    for (const line of stderr.split("\n").filter(Boolean)) {
      console.log(`[tf:stderr] ${line}`)
    }
  }

  return { exitCode: result.exitCode, stdout, stderr }
}

/**
 * Run `terraform init` in the given directory.
 */
export function tfInit(workDir: string): TfExecResult {
  return execTf(["init", "-input=false", "-no-color"], workDir)
}

/**
 * Run `terraform plan`, save the plan file, and extract the JSON plan.
 * Returns the human-readable plan output and structured JSON.
 */
export async function tfPlan(
  workDir: string,
  variables?: Record<string, string>,
): Promise<{ output: string; planJson: unknown; summary: string }> {
  // Write variables file if provided
  if (variables && Object.keys(variables).length > 0) {
    await writeFile(
      join(workDir, "terraform.tfvars.json"),
      JSON.stringify(variables, null, 2),
    )
  }

  const planFile = join(workDir, "tfplan")

  const result = execTf(
    ["plan", "-out=tfplan", "-input=false", "-no-color", "-detailed-exitcode"],
    workDir,
  )

  // Exit code 0 = no changes, 1 = error, 2 = changes present
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new TerraformError("plan", result)
  }

  const output = result.stdout

  // Extract JSON plan
  let planJson: unknown = null
  if (existsSync(planFile)) {
    const showResult = execTf(["show", "-json", "-no-color", "tfplan"], workDir)
    if (showResult.exitCode === 0) {
      try {
        planJson = JSON.parse(showResult.stdout)
      } catch {
        console.warn("[tf] failed to parse plan JSON")
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
): Promise<{ output: string; outputs: Record<string, unknown> }> {
  if (variables && Object.keys(variables).length > 0) {
    await writeFile(
      join(workDir, "terraform.tfvars.json"),
      JSON.stringify(variables, null, 2),
    )
  }

  const result = execTf(
    ["apply", "-auto-approve", "-input=false", "-no-color"],
    workDir,
  )

  if (result.exitCode !== 0) {
    throw new TerraformError("apply", result)
  }

  // Fetch outputs
  const outputResult = execTf(["output", "-json", "-no-color"], workDir)
  let outputs: Record<string, unknown> = {}
  if (outputResult.exitCode === 0 && outputResult.stdout.trim()) {
    try {
      outputs = JSON.parse(outputResult.stdout)
    } catch {
      console.warn("[tf] failed to parse outputs JSON")
    }
  }

  return { output: result.stdout, outputs }
}

/**
 * Run `terraform destroy` with auto-approve.
 */
export function tfDestroy(workDir: string): { output: string } {
  const result = execTf(
    ["destroy", "-auto-approve", "-input=false", "-no-color"],
    workDir,
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
}): Promise<TerraformResult> {
  const start = Date.now()

  try {
    // Always init first
    const initResult = tfInit(opts.workDir)
    if (initResult.exitCode !== 0) {
      return {
        success: false,
        command: opts.command,
        output: initResult.stdout,
        errorMessage: `terraform init failed: ${initResult.stderr}`,
        durationMs: Date.now() - start,
      }
    }

    switch (opts.command) {
      case "plan": {
        const { output, planJson, summary } = await tfPlan(opts.workDir, opts.variables)
        return {
          success: true,
          command: "plan",
          output,
          planJson,
          planSummary: summary,
          durationMs: Date.now() - start,
        }
      }

      case "apply": {
        const { output, outputs } = await tfApply(opts.workDir, opts.variables)
        return {
          success: true,
          command: "apply",
          output,
          outputs,
          durationMs: Date.now() - start,
        }
      }

      case "destroy": {
        const { output } = tfDestroy(opts.workDir)
        return {
          success: true,
          command: "destroy",
          output,
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
      output,
      errorMessage: msg,
      durationMs: Date.now() - start,
    }
  }
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
