import { getTfcApiHost } from "./run-token.ts"

export function getRunnerReachableTfcHost(): string {
  const runnerTfcHost = process.env.YAFFLE_RUNNER_TFC_API_HOST?.trim()
  if (runnerTfcHost) {
    return runnerTfcHost
  }

  const runnerApiUrl = process.env.YAFFLE_RUNNER_API_URL?.trim()
  if (runnerApiUrl) {
    const url = new URL(runnerApiUrl)
    return url.port === "3000" ? `${url.hostname}:6969` : url.host
  }

  try {
    return getTfcApiHost()
  } catch {
    return ""
  }
}
