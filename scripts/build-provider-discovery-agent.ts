import { parseArgs } from "node:util"

import {
  buildProviderDiscoveryAgentBundle,
  getProviderDiscoveryDefaultOutDir,
} from "./lib/provider-discovery-agent"

function parseBuildArgs(): { outDir: string; skipTypecheck: boolean } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      outdir: { type: "string" },
      "skip-typecheck": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: build-provider-discovery-agent.ts [options]

Options:
  --outdir <path>         Write the Wrangler dry-run bundle here
  --skip-typecheck        Skip the workspace typecheck preflight
  --help                  Show this help
`)
    process.exit(0)
  }

  return {
    outDir: values.outdir ?? getProviderDiscoveryDefaultOutDir(),
    skipTypecheck: values["skip-typecheck"] ?? false,
  }
}

async function main(): Promise<void> {
  const args = parseBuildArgs()

  console.log("=== Provider Discovery Agent Build ===")
  const outDir = await buildProviderDiscoveryAgentBundle(args)
  console.log(`\nBundle ready: ${outDir}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Build failed:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
