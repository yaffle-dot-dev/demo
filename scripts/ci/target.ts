import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import {
  buildPrEnvironmentName,
  findPushTriggerEnvironment,
  matchesPullRequestTrigger,
} from "../../apps/control-plane/src/lib/config-toml"

import { loadYaffleConfig } from "./config"
import type { CiTarget, EnvironmentKind } from "./types"

interface GitHubPushEvent {
  ref?: string
  before?: string
  after?: string
}

interface GitHubPullRequestRef {
  ref?: string
  sha?: string
}

interface GitHubPullRequest {
  number?: number
  head?: GitHubPullRequestRef
  base?: GitHubPullRequestRef
}

interface GitHubPullRequestEvent {
  action?: string
  number?: number
  pull_request?: GitHubPullRequest
}

export interface CreateTargetOptions {
  environmentKind: EnvironmentKind
  environmentName: string
  sha: string
  baseSha?: string
  ref?: string
  branch?: string
  prNumber?: number
}

export interface ResolveGitHubTargetOptions {
  eventName: string
  eventPath: string
  ref?: string
  sha?: string
}

function assertNonEmptyString(value: string | undefined, label: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`${label} is required`)
  }
  return trimmed
}

function normalizeBaseSha(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || /^0+$/.test(trimmed)) {
    return undefined
  }
  return trimmed
}

function parseGitHubPushTarget(
  payload: GitHubPushEvent,
  ref: string,
  sha: string,
): Promise<CiTarget> {
  return loadYaffleConfig().then((config) => {
    const environmentName = findPushTriggerEnvironment(config, ref)
    if (!environmentName) {
      throw new Error(`No named environment is configured for ref ${ref}`)
    }

    return {
      environment: {
        kind: "named",
        name: environmentName,
      },
      git: {
        sha,
        baseSha: normalizeBaseSha(payload.before),
        ref,
      },
      source: {
        kind: "github",
        event: "push",
      },
    }
  })
}

function parseGitHubPullRequestTarget(
  payload: GitHubPullRequestEvent,
  eventName: string,
): Promise<CiTarget> {
  return loadYaffleConfig().then((config) => {
    const pr = payload.pull_request
    const prNumber = pr?.number ?? payload.number
    if (!prNumber || prNumber <= 0) {
      throw new Error("GitHub pull request event is missing pull_request.number")
    }

    const branch = assertNonEmptyString(pr?.head?.ref, "pull_request.head.ref")
    if (!matchesPullRequestTrigger(config, branch)) {
      throw new Error(`No transient environment trigger matches branch ${branch}`)
    }

    return {
      environment: {
        kind: "transient",
        name: buildPrEnvironmentName(prNumber),
      },
      git: {
        sha: assertNonEmptyString(pr?.head?.sha, "pull_request.head.sha"),
        baseSha: normalizeBaseSha(pr?.base?.sha),
        ref: `refs/heads/${branch}`,
        branch,
        prNumber,
      },
      source: {
        kind: "github",
        event: eventName,
        action: payload.action?.trim() || undefined,
      },
    }
  })
}

export function createTarget(options: CreateTargetOptions): CiTarget {
  return {
    environment: {
      kind: options.environmentKind,
      name: options.environmentName,
    },
    git: {
      sha: options.sha,
      baseSha: normalizeBaseSha(options.baseSha),
      ref: options.ref,
      branch: options.branch,
      prNumber: options.prNumber,
    },
    source: {
      kind: "manual",
      event: "manual",
    },
  }
}

export async function resolveGitHubTarget(options: ResolveGitHubTargetOptions): Promise<CiTarget> {
  const payloadRaw = await readFile(options.eventPath, "utf8")
  const payload = JSON.parse(payloadRaw) as GitHubPushEvent | GitHubPullRequestEvent

  if (options.eventName === "push") {
    return parseGitHubPushTarget(
      payload as GitHubPushEvent,
      assertNonEmptyString(options.ref ?? (payload as GitHubPushEvent).ref, "GitHub ref"),
      assertNonEmptyString(options.sha ?? (payload as GitHubPushEvent).after, "GitHub sha"),
    )
  }

  if (options.eventName === "pull_request" || options.eventName === "pull_request_target") {
    return parseGitHubPullRequestTarget(payload as GitHubPullRequestEvent, options.eventName)
  }

  throw new Error(`Unsupported GitHub event: ${options.eventName}`)
}

export async function readTarget(filePath: string): Promise<CiTarget> {
  const raw = await readFile(filePath, "utf8")
  return JSON.parse(raw) as CiTarget
}

export async function writeTarget(filePath: string, target: CiTarget): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(target, null, 2)}\n`, "utf8")
}
