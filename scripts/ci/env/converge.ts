import { parallel } from "../../lib/exec"
import { fetchOutputs } from "../../lib/outputs"

import { discoverDeployables } from "../deployables/discovery"
import { resolveArtifactPlan } from "../deployables/artifact-resolution"
import { buildDeployableExecutionGraph, getDeployableExecutionOrder } from "../deployables/execution-graph"
import { assertSecretChecksPassed, checkDeployableSecrets, withDeployablePhaseSecrets } from "../secrets"
import { listChangedFiles } from "../git"
import { planDeployables } from "../deployables/planner"
import { readTarget } from "../target"
import type { CiTarget, ConvergeResult } from "../types"
import type { DeployableArtifactResolution, DiscoveredDeployable } from "../deployables/types"
import type { DeployableExecutionResult } from "../types"

export interface ConvergeEnvironmentOptions {
  targetPath: string
  all?: boolean
  dryRun?: boolean
  requestedDeployables?: string[]
}

export type DeployableLifecyclePhase = "activation" | "verification"

export interface RunDeployableLifecyclePhaseOptions {
  deployable: DiscoveredDeployable
  target: CiTarget
  phase: DeployableLifecyclePhase
  dryRun?: boolean
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
  artifactPlan: Map<string, DeployableArtifactResolution>,
): Promise<void> {
  await parallel(deployables.map((deployable) => ({
    name: `build:${deployable.name}`,
    fn: async () => {
      const artifact = artifactPlan.get(deployable.name)
      if (artifact) {
        console.log(`[build:${deployable.name}] strategy=${artifact.strategy} artifact=${artifact.artifactRef}`)
      }
      await withDeployablePhaseSecrets({
        deployable,
        phase: "build",
        target,
        fn: async () => {
          await deployable.build({ target, dryRun, artifact })
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
  artifactPlan: Map<string, DeployableArtifactResolution>,
): Promise<void> {
  const ordered = [
    ...deployables.filter((deployable) => deployable.name === "control-plane"),
    ...deployables.filter((deployable) => deployable.name !== "control-plane"),
  ]

  for (const deployable of ordered) {
    console.log(`[deploy:${deployable.name}] starting`)
    try {
      const artifact = artifactPlan.get(deployable.name)
      await withDeployablePhaseSecrets({
        deployable,
        phase: "deploy",
        target,
        fn: async () => {
          if (artifact) {
            console.log(`[deploy:${deployable.name}] strategy=${artifact.strategy} artifact=${artifact.artifactRef}`)
          }
          await deployable.deploy({ target, dryRun, artifact })
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

async function convergeDeployable(
  deployable: DiscoveredDeployable,
  target: CiTarget,
  dryRun: boolean,
  artifactPlan: Map<string, DeployableArtifactResolution>,
): Promise<void> {
  const workspaces = getSelectedWorkspaces([deployable])

  console.log(`[deployable:${deployable.name}] workspaces: ${workspaces.join(", ")}`)
  await waitForWorkspaces(workspaces, target)

  const secretChecks = await checkDeployableSecrets({
    deployables: [deployable],
    target,
  })
  assertSecretChecksPassed(secretChecks)

  await withTargetEnvironment(target, dryRun, async () => {
    await prepareDeployables([deployable], target, dryRun)
    await buildDeployables([deployable], target, dryRun, artifactPlan)
    await deployDeployables([deployable], target, dryRun, artifactPlan)
    await verifyDeployables([deployable], target, dryRun)
  })
}

export async function runDeployableLifecyclePhase(
  options: RunDeployableLifecyclePhaseOptions,
): Promise<void> {
  const dryRun = options.dryRun ?? false
  const workspaces = getSelectedWorkspaces([options.deployable])

  await withTargetEnvironment(options.target, dryRun, async () => {
    const artifactPlan = await resolveArtifactPlan({
      deployables: [options.deployable],
      target: options.target,
    })
    await waitForWorkspaces(workspaces, options.target)

    if (options.phase === "activation") {
      await prepareDeployables([options.deployable], options.target, dryRun)
      await buildDeployables([options.deployable], options.target, dryRun, artifactPlan)
      await deployDeployables([options.deployable], options.target, dryRun, artifactPlan)
      return
    }

    await verifyDeployables([options.deployable], options.target, dryRun)
  })
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
      execution: [],
    }
  }

  console.log(`Deployables: ${deployables.map((deployable) => deployable.name).join(", ")}`)
  console.log(`Workspaces: ${workspaces.join(", ")}`)

  const unsupported = plan.entries.filter((entry) => entry.status === "unsupported_for_target")
  for (const entry of unsupported) {
    console.warn(`Skipping ${entry.name}: ${entry.reasons.join("; ")}`)
  }

  const executionGraph = await buildDeployableExecutionGraph(deployables)
  const executionOrder = getDeployableExecutionOrder(executionGraph)
  const graphByName = new Map(executionGraph.map((node) => [node.deployable.name, node]))
  const executionResults: DeployableExecutionResult[] = []
  const statusByName = new Map<string, DeployableExecutionResult["status"]>()
  const dryRun = options.dryRun ?? false
  const artifactPlan = await withTargetEnvironment(target, dryRun, async () =>
    resolveArtifactPlan({ deployables, target })
  )

  console.log(`Execution order: ${executionOrder.join(", ")}`)

  for (const name of executionOrder) {
    const node = graphByName.get(name)
    if (!node) {
      continue
    }

    const blockedBy = node.dependencies.filter((dependency) => statusByName.get(dependency) !== "completed")
    if (blockedBy.length > 0) {
      const result: DeployableExecutionResult = {
        name,
        status: "skipped",
        dependencies: [...node.dependencies],
        workspaces: [...node.deployable.workspaces],
        error: `blocked by failed dependencies: ${blockedBy.join(", ")}`,
      }
      executionResults.push(result)
      statusByName.set(name, result.status)
      console.warn(`[deployable:${name}] skipped; ${result.error}`)
      continue
    }

    try {
      await convergeDeployable(node.deployable, target, dryRun, artifactPlan)
      const result: DeployableExecutionResult = {
        name,
        status: "completed",
        dependencies: [...node.dependencies],
        workspaces: [...node.deployable.workspaces],
      }
      executionResults.push(result)
      statusByName.set(name, result.status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: DeployableExecutionResult = {
        name,
        status: "failed",
        dependencies: [...node.dependencies],
        workspaces: [...node.deployable.workspaces],
        error: message,
      }
      executionResults.push(result)
      statusByName.set(name, result.status)
      console.error(`[deployable:${name}] failed: ${message}`)
    }
  }

  const failures = executionResults.filter((result) => result.status !== "completed")
  if (failures.length > 0) {
    const detail = failures
      .map((result) => `${result.name}: ${result.error ?? result.status}`)
      .join("\n")
    throw new Error(`Converge completed with failures:\n${detail}`)
  }

  return {
    target,
    deployables: deployables.map((deployable) => deployable.name),
    workspaces,
    changedFiles: changeSet.files,
    mode: changeSet.mode,
    dryRun,
    plan: plan.entries,
    execution: executionResults,
  }
}
