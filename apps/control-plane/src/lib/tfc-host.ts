export function getRunnerReachableTfcHost(): string {
  const runnerTfcHost = process.env.YAFFLE_RUNNER_TFC_API_HOST?.trim()
  if (runnerTfcHost) {
    return runnerTfcHost
  }

  throw new Error("YAFFLE_RUNNER_TFC_API_HOST must be configured")
}
