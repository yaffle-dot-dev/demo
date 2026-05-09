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

import { mkdir, rm } from "node:fs/promises"

import { exec } from "./lib/exec"
import { isMain } from "./lib/module"

export async function buildScanner() {
  await mkdir("dist", { recursive: true })
  const bundleDir = "dist/scanner-lambda-build"
  await rm(bundleDir, { recursive: true, force: true })

  console.log("Bundling scanner-lambda.ts → dist/scanner-lambda.mjs")
  await exec([
    "vp", "pack",
    "apps/runner/src/scanner-lambda.ts",
    "--out-dir", bundleDir,
    "--target", "node25",
    "--format", "esm",
  ])

  console.log("Creating dist/scanner-lambda.zip")
  await exec([
    "bash", "-lc", "zip -j dist/scanner-lambda.zip dist/scanner-lambda-build/*.mjs",
  ])

  console.log("Scanner Lambda zip ready: dist/scanner-lambda.zip")
}

if (isMain(import.meta)) {
  await buildScanner()
}
