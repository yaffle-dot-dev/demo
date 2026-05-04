import { parseArgs } from "node:util"

import { completeCli, renderCompletionScript } from "./completion"
import { convergeEnvironment, runDeployableLifecyclePhase } from "./env/converge"
import { discoverDeployables } from "./deployables/discovery"
import { planDeployables } from "./deployables/planner"
import { listNamedEnvironments } from "./environments"
import { assertSecretChecksPassed, checkDeployableSecrets, ensureDeployableSecrets } from "./secrets"
import { readTarget, resolveGitHubTarget, writeTarget, createTarget } from "./target"
import { listChangedFiles } from "./git"

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function requireSubcommand(value: string | undefined, usage: string): string {
  if (!value) {
    throw new Error(`Missing subcommand. Usage: ${usage}`)
  }

  return value
}

async function handleTargetCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      kind: { type: "string" },
      environment: { type: "string" },
      sha: { type: "string" },
      "base-sha": { type: "string" },
      ref: { type: "string" },
      branch: { type: "string" },
      pr: { type: "string" },
      out: { type: "string" },
    },
  })

  const kind = values.kind
  const environmentName = values.environment
  const sha = values.sha

  if ((kind !== "named" && kind !== "transient") || !environmentName || !sha) {
    throw new Error("Usage: ci target create --kind <named|transient> --environment <name> --sha <sha> [--base-sha <sha>] [--out <path>]")
  }

  const prNumber = values.pr ? Number.parseInt(values.pr, 10) : undefined
  const target = createTarget({
    environmentKind: kind,
    environmentName,
    sha,
    baseSha: values["base-sha"],
    ref: values.ref,
    branch: values.branch,
    prNumber,
  })

  if (values.out) {
    await writeTarget(values.out, target)
    return
  }

  printJson(target)
}

async function handleTargetResolve(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "github-event-name": { type: "string" },
      "github-event-path": { type: "string" },
      "github-ref": { type: "string" },
      "github-sha": { type: "string" },
      out: { type: "string" },
    },
  })

  const eventName = values["github-event-name"] ?? process.env.GITHUB_EVENT_NAME
  const eventPath = values["github-event-path"] ?? process.env.GITHUB_EVENT_PATH

  if (!eventName || !eventPath) {
    throw new Error("Usage: ci target resolve --github-event-name <event> --github-event-path <path> [--github-ref <ref>] [--github-sha <sha>] [--out <path>]")
  }

  const target = await resolveGitHubTarget({
    eventName,
    eventPath,
    ref: values["github-ref"] ?? process.env.GITHUB_REF,
    sha: values["github-sha"] ?? process.env.GITHUB_SHA,
  })

  if (values.out) {
    await writeTarget(values.out, target)
    return
  }

  printJson(target)
}

async function handleDeployablesDetect(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string", default: ".ci/target.json" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      deployable: { type: "string", multiple: true },
    },
  })

  const target = await readTarget(values.target)
  const changedFiles = values.all || !target.git.baseSha
    ? []
    : await listChangedFiles(target.git.baseSha, target.git.sha)
  const plan = planDeployables({
    deployables: await discoverDeployables(),
    environmentKind: target.environment.kind,
    changedFiles: values.all || !target.git.baseSha ? null : changedFiles,
    requestedDeployables: values.deployable,
  })

  if (values.json) {
    printJson({
      target,
      deployables: plan.selected.map((deployable) => deployable.name),
      changedFiles,
      plan: plan.entries,
    })
    return
  }

  for (const deployable of plan.selected.map((item) => item.name)) {
    console.log(deployable)
  }
}

async function handleSecretsCheck(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string", default: ".ci/target.json" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      deployable: { type: "string", multiple: true },
    },
  })

  const target = await readTarget(values.target)
  const changedFiles = values.all || !target.git.baseSha
    ? []
    : await listChangedFiles(target.git.baseSha, target.git.sha)
  const plan = planDeployables({
    deployables: await discoverDeployables(),
    environmentKind: target.environment.kind,
    changedFiles: values.all || !target.git.baseSha ? null : changedFiles,
    requestedDeployables: values.deployable,
  })
  const checks = await checkDeployableSecrets({
    deployables: plan.selected,
    target,
  })

  if (values.json) {
    printJson({
      target,
      deployables: plan.selected.map((deployable) => deployable.name),
      plan: plan.entries,
      checks,
    })
  } else {
    if (checks.length === 0) {
      console.log("No declared secrets for selected deployables")
    }

    for (const check of checks) {
      console.log(`${check.status}\t${check.deployable}\t${check.phase}\t${check.secret}`)
    }
  }

  assertSecretChecksPassed(checks)
}

async function handleSecretsEnsure(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string", default: ".ci/target.json" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      deployable: { type: "string", multiple: true },
    },
  })

  const target = await readTarget(values.target)
  const changedFiles = values.all || !target.git.baseSha
    ? []
    : await listChangedFiles(target.git.baseSha, target.git.sha)
  const plan = planDeployables({
    deployables: await discoverDeployables(),
    environmentKind: target.environment.kind,
    changedFiles: values.all || !target.git.baseSha ? null : changedFiles,
    requestedDeployables: values.deployable,
  })

  const ensure = await ensureDeployableSecrets({
    deployables: plan.selected,
    target,
  })
  const checks = await checkDeployableSecrets({
    deployables: plan.selected,
    target,
  })

  if (values.json) {
    printJson({
      target,
      deployables: plan.selected.map((deployable) => deployable.name),
      plan: plan.entries,
      ensure,
      checks,
    })
  } else {
    if (ensure.length === 0) {
      console.log("No declarative secret ensures for selected deployables")
    }

    for (const entry of ensure) {
      console.log(`${entry.status}\t${entry.deployable}\t${entry.phase}\t${entry.secret}`)
    }
  }

  assertSecretChecksPassed(checks)
}

async function handleDeployablesList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      "environment-kind": { type: "string" },
    },
  })

  const deployables = await discoverDeployables()
  const filtered = values["environment-kind"]
    ? deployables.filter((deployable) => deployable.supports.environmentKinds.includes(values["environment-kind"] as "named" | "transient"))
    : deployables

  if (values.json) {
    printJson(filtered.map((deployable) => ({
      name: deployable.name,
      root: deployable.root,
      environmentKinds: deployable.supports.environmentKinds,
      workspaces: deployable.workspaces,
      watchedPaths: deployable.watchedPaths,
      descriptorPath: deployable.descriptorPath,
    })))
    return
  }

  for (const deployable of filtered) {
    console.log(deployable.name)
  }
}

async function handleEnvironmentsList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
    },
  })

  const environments = await listNamedEnvironments()
  if (values.json) {
    printJson(environments)
    return
  }

  for (const environment of environments) {
    console.log(environment)
  }
}

async function handleEnvironmentConverge(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string", default: ".ci/target.json" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      deployable: { type: "string", multiple: true },
    },
  })

  const result = await convergeEnvironment({
    targetPath: values.target,
    all: values.all,
    dryRun: values["dry-run"],
    requestedDeployables: values.deployable,
  })

  if (values.json) {
    printJson(result)
  }
}

async function handleEnvironmentLifecycle(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string", default: ".ci/target.json" },
      phase: { type: "string" },
      deployable: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  })

  if (
    (values.phase !== "activation" && values.phase !== "verification")
    || !values.deployable
  ) {
    throw new Error(
      "Usage: ci env lifecycle --target <path> --phase <activation|verification> --deployable <name> [--dry-run]",
    )
  }

  const target = await readTarget(values.target)
  const deployable = (await discoverDeployables()).find((candidate) => candidate.name === values.deployable)
  if (!deployable) {
    throw new Error(`Unknown deployable '${values.deployable}'`)
  }
  if (!deployable.supports.environmentKinds.includes(target.environment.kind)) {
    throw new Error(
      `Deployable '${deployable.name}' does not support ${target.environment.kind} environments`,
    )
  }

  await runDeployableLifecyclePhase({
    deployable,
    target,
    phase: values.phase,
    dryRun: values["dry-run"],
  })
}

async function handleCompletion(args: string[]): Promise<void> {
  const shell = args[0]
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    throw new Error("Usage: ci completion <bash|zsh|fish>")
  }

  console.log(renderCompletionScript(shell))
}

async function handleHiddenCompletion(args: string[]): Promise<void> {
  const completions = await completeCli(args)
  for (const completion of completions) {
    console.log(completion)
  }
}

async function main(): Promise<void> {
  const [scope, action, ...rest] = process.argv.slice(2)

  switch (scope) {
    case "target": {
      const subcommand = requireSubcommand(action, "ci target <create|resolve>")
      if (subcommand === "create") {
        await handleTargetCreate(rest)
        return
      }
      if (subcommand === "resolve") {
        await handleTargetResolve(rest)
        return
      }
      break
    }
    case "deployables": {
      const subcommand = requireSubcommand(action, "ci deployables <detect|list>")
      if (subcommand === "detect") {
        await handleDeployablesDetect(rest)
        return
      }
      if (subcommand === "list") {
        await handleDeployablesList(rest)
        return
      }
      break
    }
    case "secrets": {
      const subcommand = requireSubcommand(action, "ci secrets <check|ensure>")
      if (subcommand === "check") {
        await handleSecretsCheck(rest)
        return
      }
      if (subcommand === "ensure") {
        await handleSecretsEnsure(rest)
        return
      }
      break
    }
    case "environments": {
      const subcommand = requireSubcommand(action, "ci environments <list>")
      if (subcommand === "list") {
        await handleEnvironmentsList(rest)
        return
      }
      break
    }
    case "env": {
      const subcommand = requireSubcommand(action, "ci env <converge|lifecycle>")
      if (subcommand === "converge") {
        await handleEnvironmentConverge(rest)
        return
      }
      if (subcommand === "lifecycle") {
        await handleEnvironmentLifecycle(rest)
        return
      }
      break
    }
    case "completion": {
      await handleCompletion([action, ...rest].filter((value): value is string => Boolean(value)))
      return
    }
    case "__complete": {
      await handleHiddenCompletion([action, ...rest].filter((value): value is string => value !== undefined))
      return
    }
  }

  throw new Error(
    "Usage:\n"
    + "  ci target create ...\n"
    + "  ci target resolve ...\n"
    + "  ci deployables list ...\n"
    + "  ci deployables detect ...\n"
    + "  ci secrets ensure ...\n"
    + "  ci secrets check ...\n"
    + "  ci environments list ...\n"
    + "  ci env converge ...\n"
    + "  ci env lifecycle ...\n"
    + "  ci completion <bash|zsh|fish>"
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
