import { parallel } from "../../lib/exec"
import { fetchOutputs } from "../../lib/outputs"

import { discoverDeployables } from "../deployables/discovery"
import { assertSecretChecksPassed, checkDeployableSecrets, withDeployablePhaseSecrets } from "../secrets"
import { listChangedFiles } from "../git"
import { planDeployables } from "../deployables/planner"
import { readTarget } from "../target"
import type { CiTarget, ConvergeResult } from "../types"
import type { DiscoveredDeployable } from "../deployables/types"

export interface ConvergeEnvironmentOptions {
  targetPath: string
  all?: boolean
  dryRun?: boolean
  requestedDeployables?: string[]
}

function deriveTier(target: CiTarget): string {
  return target.environment.kind === "named" && target.environment.name === "main"
    ? "production"
    : "nonprod"
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function getSelectedWorkspaces(deployables: DiscoveredDeployable[]): string[] {
  return unique(deployables.flatMap((deployable) => deployable.workspaces))
}

async function loadChangedFiles(target: CiTarget, forceAll: boolean): Promise<{ mode: "all" | "changed"; files: string[] }> {
  if (forceAll || !target.git.baseSha) {
    return { mode: "all", files: [] }
  }

  return {
    mode: "changed",
    files: await listChangedFiles(target.git.baseSha, target.git.sha),
  }
}

async function waitForWorkspaces(workspaces: string[], target: CiTarget): Promise<void> {
  await parallel(workspaces.map((workspace) => ({
    name: `workspace:${workspace}`,
    fn: async () => {
      await fetchOutputs({
        workspace,
        environment: target.environment.name,
        wait: true,
        waitTimeout: 600,
      })
    },
  })))
}

async function withTargetEnvironment<T>(
  target: CiTarget,
  dryRun: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const previousEnv = {
    YAFFLE_ENVIRONMENT_NAME: process.env.YAFFLE_ENVIRONMENT_NAME,
    YAFFLE_ENVIRONMENT_KIND: process.env.YAFFLE_ENVIRONMENT_KIND,
    YAFFLE_SHA: process.env.YAFFLE_SHA,
    YAFFLE_PUSH: process.env.YAFFLE_PUSH,
    YAFFLE_TIER: process.env.YAFFLE_TIER,
    YAFFLE_DRY_RUN: process.env.YAFFLE_DRY_RUN,
  }

  process.env.YAFFLE_ENVIRONMENT_NAME = target.environment.name
  process.env.YAFFLE_ENVIRONMENT_KIND = target.environment.kind
  process.env.YAFFLE_SHA = target.git.sha
  process.env.YAFFLE_PUSH = dryRun ? "false" : "true"
  process.env.YAFFLE_TIER = deriveTier(target)
  process.env.YAFFLE_DRY_RUN = dryRun ? "true" : "false"

  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (typeof value === "string") {
        process.env[key] = value
      } else {
        delete process.env[key]
      }
    }
  }
}

async function buildDeployables(
  deployables: DiscoveredDeployable[],
  target: CiTarget,
  dryRun: boolean,
): Promise<void> {
  await parallel(deployables.map((deployable) => ({
    name: `build:${deployable.name}`,
    fn: async () => {
      await withDeployablePhaseSecrets({
        deployable,
        phase: "build",
        target,
        fn: async () => {
          await deployable.build({ target, dryRun })
        },
      })
    },
  })))
}

async function prepareDeployables(
  deployables: DiscoveredDeployable[],
  target: CiTarget,
  dryRun: boolean,
): Promise<void> {
  const preparable = deployables.filter((deployable) => typeof deployable.prepare === "function")
  if (preparable.length === 0) {
    return
  }

  const controlPlane = preparable.find((deployable) => deployable.name === "control-plane")
  if (controlPlane?.prepare) {
    await withDeployablePhaseSecrets({
      deployable: controlPlane,
      phase: "prepare",
      target,
      fn: async () => {
        await controlPlane.prepare?.({ target, dryRun })
      },
    })
  }

  const remaining = preparable.filter((deployable) => deployable.name !== "control-plane")
  if (remaining.length === 0) {
    return
  }

  await parallel(remaining.map((deployable) => ({
    name: `prepare:${deployable.name}`,
    fn: async () => {
      await withDeployablePhaseSecrets({
        deployable,
        phase: "prepare",
        target,
        fn: async () => {
          await deployable.prepare?.({ target, dryRun })
        },
      })
    },
  })))
}

async function deployDeployables(
  deployables: DiscoveredDeployable[],
  target: CiTarget,
  dryRun: boolean,
): Promise<void> {
  const ordered = [
    ...deployables.filter((deployable) => deployable.name === "control-plane"),
    ...deployables.filter((deployable) => deployable.name !== "control-plane"),
  ]

  for (const deployable of ordered) {
    console.log(`[deploy:${deployable.name}] starting`)
    try {
      await withDeployablePhaseSecrets({
        deployable,
        phase: "deploy",
        target,
        fn: async () => {
          await deployable.deploy({ target, dryRun })
        },
      })
      console.log(`[deploy:${deployable.name}] done`)
    } catch (error) {
      console.log(`[deploy:${deployable.name}] failed`)
      throw error
    }
  }
}

async function verifyDeployables(
  deployables: DiscoveredDeployable[],
  target: CiTarget,
  dryRun: boolean,
): Promise<void> {
  const verifiable = deployables.filter((deployable) => typeof deployable.verify === "function")
  if (verifiable.length === 0) {
    return
  }

  const controlPlane = verifiable.find((deployable) => deployable.name === "control-plane")
  if (controlPlane?.verify) {
    await withDeployablePhaseSecrets({
      deployable: controlPlane,
      phase: "verify",
      target,
      fn: async () => {
        await controlPlane.verify?.({ target, dryRun })
      },
    })
  }

  const remaining = verifiable.filter((deployable) => deployable.name !== "control-plane")
  if (remaining.length === 0) {
    return
  }

  await parallel(remaining.map((deployable) => ({
    name: `verify:${deployable.name}`,
    fn: async () => {
      await withDeployablePhaseSecrets({
        deployable,
        phase: "verify",
        target,
        fn: async () => {
          await deployable.verify?.({ target, dryRun })
        },
      })
    },
  })))
}

export async function convergeEnvironment(
  options: ConvergeEnvironmentOptions,
): Promise<ConvergeResult> {
  const target = await readTarget(options.targetPath)
  const changeSet = await loadChangedFiles(target, options.all ?? false)
  const discoveredDeployables = await discoverDeployables()
  const plan = planDeployables({
    deployables: discoveredDeployables,
    environmentKind: target.environment.kind,
    changedFiles: changeSet.mode === "all" ? null : changeSet.files,
    requestedDeployables: options.requestedDeployables,
  })
  const deployables = plan.selected
  const workspaces = getSelectedWorkspaces(deployables)

  console.log(`Converging ${target.environment.kind} environment ${target.environment.name}`)
  console.log(`Commit: ${target.git.sha}`)
  console.log(`Mode: ${changeSet.mode}`)

  if (deployables.length === 0) {
    console.log("No deployables selected")
    return {
      target,
      deployables: [],
      workspaces: [],
      changedFiles: changeSet.files,
      mode: changeSet.mode,
      dryRun: options.dryRun ?? false,
      plan: plan.entries,
    }
  }

  console.log(`Deployables: ${deployables.map((deployable) => deployable.name).join(", ")}`)
  console.log(`Workspaces: ${workspaces.join(", ")}`)

  const unsupported = plan.entries.filter((entry) => entry.status === "unsupported_for_target")
  for (const entry of unsupported) {
    console.warn(`Skipping ${entry.name}: ${entry.reasons.join("; ")}`)
  }

  await waitForWorkspaces(workspaces, target)

  const secretChecks = await checkDeployableSecrets({
    deployables,
    target,
  })
  assertSecretChecksPassed(secretChecks)

  await withTargetEnvironment(target, options.dryRun ?? false, async () => {
    await prepareDeployables(deployables, target, options.dryRun ?? false)
    await buildDeployables(deployables, target, options.dryRun ?? false)
    await deployDeployables(deployables, target, options.dryRun ?? false)
    await verifyDeployables(deployables, target, options.dryRun ?? false)
  })

  return {
    target,
    deployables: deployables.map((deployable) => deployable.name),
    workspaces,
    changedFiles: changeSet.files,
    mode: changeSet.mode,
    dryRun: options.dryRun ?? false,
    plan: plan.entries,
  }
}
