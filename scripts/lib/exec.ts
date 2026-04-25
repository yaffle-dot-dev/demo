/**
 * Shell execution and parallel task helpers.
 */

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  /** If true, don't stream output (capture only) */
  quiet?: boolean
}

function sanitizeCommand(cmd: string[]): string {
  const redactedFlags = new Set([
    "--secret-string",
    "--secret-binary",
    "--password",
    "--token",
    "--access-token",
    "--client-secret",
  ])

  const sanitized: string[] = []

  for (let i = 0; i < cmd.length; i += 1) {
    const part = cmd[i]
    sanitized.push(part)

    if (redactedFlags.has(part) && i + 1 < cmd.length) {
      sanitized.push("[REDACTED]")
      i += 1
    }
  }

  return sanitized.join(" ")
}

/**
 * Run a command, stream output, throw on non-zero exit.
 */
export async function exec(cmd: string[], opts?: ExecOptions): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    stdout: opts?.quiet ? "pipe" : "inherit",
    stderr: opts?.quiet ? "pipe" : "inherit",
  })

  const result = await proc.exited
  const stdout = opts?.quiet && proc.stdout ? await new Response(proc.stdout).text() : ""
  const stderr = opts?.quiet && proc.stderr ? await new Response(proc.stderr).text() : ""

  if (result !== 0) {
    const detail = stderr.trim() || stdout.trim()
    throw new Error(
      detail
        ? `Command failed (exit ${result}): ${sanitizeCommand(cmd)}\n${detail}`
        : `Command failed (exit ${result}): ${sanitizeCommand(cmd)}`,
    )
  }

  return stdout
}

export interface ParallelTask {
  name: string
  fn: () => Promise<void>
}

/**
 * Run tasks in parallel. All tasks run concurrently; if any fail,
 * all errors are collected and reported.
 */
export async function parallel(tasks: ParallelTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(async (task) => {
    console.log(`[${task.name}] starting`)
    try {
      await task.fn()
      console.log(`[${task.name}] done`)
    } catch (err) {
      console.error(`[${task.name}] failed`)
      throw err
    }
  }))

  const failures = results
    .map((r, i) => ({ result: r, name: tasks[i].name }))
    .filter((r) => r.result.status === "rejected")

  if (failures.length > 0) {
    const names = failures.map((f) => f.name).join(", ")
    const errors = failures.map((f) =>
      (f.result as PromiseRejectedResult).reason
    )
    console.error(`\nFailed tasks: ${names}`)
    for (const err of errors) {
      console.error(err)
    }
    throw new Error(`${failures.length} task(s) failed: ${names}`)
  }
}
