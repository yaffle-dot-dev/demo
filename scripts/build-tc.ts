import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { exec } from "./lib/exec"

const REPO_ROOT = resolve(import.meta.dir, "..")
const TRAFFIC_CONTROLLER_DIR = resolve(REPO_ROOT, "apps/traffic-controller")
const TRAFFIC_CONTROLLER_DIST_DIR = resolve(REPO_ROOT, "dist/traffic-controller")
const API_ENTRYPOINT = resolve(TRAFFIC_CONTROLLER_DIR, "src/api-lambda.ts")
const RECONCILE_ENTRYPOINT = resolve(TRAFFIC_CONTROLLER_DIR, "src/reconcile-lambda.ts")
const API_BUNDLE = resolve(TRAFFIC_CONTROLLER_DIST_DIR, "api-lambda.mjs")
const API_ZIP = resolve(TRAFFIC_CONTROLLER_DIST_DIR, "api-lambda.zip")
const RECONCILE_BUNDLE = resolve(TRAFFIC_CONTROLLER_DIST_DIR, "reconcile-lambda.mjs")
const RECONCILE_ZIP = resolve(TRAFFIC_CONTROLLER_DIST_DIR, "reconcile-lambda.zip")

export interface BuildTrafficControllerOptions {
  skipTypecheck?: boolean
}

function parseBuildArgs(): BuildTrafficControllerOptions {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "skip-typecheck": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: build-tc.ts [options]

Options:
  --skip-typecheck        Skip the workspace typecheck preflight
  --help                  Show this help
`)
    process.exit(0)
  }

  return {
    skipTypecheck: values["skip-typecheck"] ?? false,
  }
}

async function bundleLambda(entrypoint: string, outfile: string, zipPath: string): Promise<void> {
  await rm(outfile, { force: true })
  await rm(zipPath, { force: true })

  await exec([
    "bun",
    "build",
    entrypoint,
    "--outfile",
    outfile,
    "--target",
    "node",
    "--format",
    "esm",
  ], {
    cwd: REPO_ROOT,
  })

  await exec([
    "zip",
    "-j",
    zipPath,
    outfile,
  ], {
    cwd: REPO_ROOT,
  })
}

export async function buildTrafficController(
  options: BuildTrafficControllerOptions = {},
): Promise<void> {
  await mkdir(TRAFFIC_CONTROLLER_DIST_DIR, { recursive: true })

  if (!options.skipTypecheck) {
    console.log("Typechecking traffic-controller...")
    await exec(["bun", "run", "--filter=@yaffle/traffic-controller", "typecheck"], {
      cwd: REPO_ROOT,
    })
  }

  console.log("Bundling traffic-controller API Lambda...")
  await bundleLambda(API_ENTRYPOINT, API_BUNDLE, API_ZIP)

  console.log("Bundling traffic-controller reconcile Lambda...")
  await bundleLambda(RECONCILE_ENTRYPOINT, RECONCILE_BUNDLE, RECONCILE_ZIP)

  console.log(`Traffic-controller Lambda zips ready:`)
  console.log(`- ${API_ZIP}`)
  console.log(`- ${RECONCILE_ZIP}`)
}

if (import.meta.main) {
  await buildTrafficController(parseBuildArgs())
}
