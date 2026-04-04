/**
 * Build the scanner Lambda function zip.
 *
 * 1. Bundles scanner-lambda.ts → scanner-lambda.mjs (Node.js target)
 * 2. Zips it for Lambda deployment
 *
 * Output: dist/scanner-lambda.zip
 *
 * Layers (git, tailscale) are built separately via nix:
 *   nix build .#lambda-layer-git
 *   nix build .#lambda-layer-tailscale
 */

import { mkdir } from "node:fs/promises"
import { exec } from "./lib/exec"

export async function buildScanner() {
  await mkdir("dist", { recursive: true })

  console.log("Bundling scanner-lambda.ts → dist/scanner-lambda.mjs")
  await exec([
    "bun", "build",
    "apps/runner/src/scanner-lambda.ts",
    "--outfile", "dist/scanner-lambda.mjs",
    "--target", "node",
    "--format", "esm",
  ])

  console.log("Creating dist/scanner-lambda.zip")
  await exec([
    "zip", "-j", "dist/scanner-lambda.zip", "dist/scanner-lambda.mjs",
  ])

  console.log("Scanner Lambda zip ready: dist/scanner-lambda.zip")
}

if (import.meta.main) {
  await buildScanner()
}
