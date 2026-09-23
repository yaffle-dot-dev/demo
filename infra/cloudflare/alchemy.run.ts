import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

interface YaffleVariables {
  demo_message?: unknown
  environment?: unknown
  environment_kind?: unknown
}

function yaffleVariables(): YaffleVariables {
  const raw = process.env.YAFFLE_VARIABLES_JSON
  if (!raw) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAFFLE_VARIABLES_JSON must contain an object")
  }
  return parsed as YaffleVariables
}

const variables = yaffleVariables()
const environment =
  typeof variables.environment === "string" ? variables.environment : "development"
const environmentKind =
  typeof variables.environment_kind === "string" ? variables.environment_kind : "named"
const demoMessage =
  typeof variables.demo_message === "string"
    ? variables.demo_message
    : "Hello from a Yaffle-managed Cloudflare environment"

export default Alchemy.Stack(
  "YaffleDemoEdge",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const demoState = yield* Cloudflare.KV.Namespace("DemoState")
    const worker = yield* Cloudflare.Worker("DemoWorker", {
      main: "./src/worker.ts",
      compatibility: { date: "2026-08-25" },
      workersDev: { enabled: true, previewsEnabled: false },
      observability: { enabled: false },
      env: {
        DEMO_STATE: demoState,
        DEMO_MESSAGE: demoMessage,
        YAFFLE_ENVIRONMENT: environment,
        YAFFLE_ENVIRONMENT_KIND: environmentKind,
      },
    })

    return {
      url: { value: worker.url, sensitive: false },
      worker_name: { value: worker.workerName, sensitive: false },
      kv_namespace_id: { value: demoState.namespaceId, sensitive: false },
    }
  }),
)
