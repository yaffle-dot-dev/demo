import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda"
import {
  buildDefaultDeploymentId,
  parseTrafficControllerComment,
} from "./lib/traffic-controller-comment"

const COMMENT_MARKER = "<!-- yaffle:traffic-controller -->"

interface TrafficControllerResponse {
  data: {
    status: string
    operationId?: string
    resourceId?: string
    code?: string
    message?: string
    operation?: {
      operationId: string
      operationType: string
      status: string
      resultCode?: string
      resultMessage?: string
      leaseId?: string
      routeableDeploymentId?: string
      output?: Record<string, unknown>
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? ""
  if (!value) {
    throw new Error(`${name} must be configured`)
  }

  return value
}

async function invokeTrafficController(
  payload: Record<string, unknown>,
): Promise<TrafficControllerResponse> {
  const functionName = requireEnv("TRAFFIC_CONTROLLER_FUNCTION_NAME")
  const region = process.env.AWS_REGION?.trim() || "us-east-1"
  const lambda = new LambdaClient({ region })
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  )

  const decoded = new TextDecoder().decode(response.Payload)
  return JSON.parse(decoded) as TrafficControllerResponse
}

function formatOperationComment(params: {
  actorLogin: string
  prNumber: number
  desiredState: "active" | "absent"
  commandBody: string
  response: TrafficControllerResponse
}): string {
  const data = params.response.data
  const heading = params.desiredState === "active" ? "lease requested" : "lease revoke requested"

  if (data.status === "rejected") {
    return [
      COMMENT_MARKER,
      `Traffic-controller ${heading} by @${params.actorLogin} failed.`,
      "",
      `- command: \`${params.commandBody.trim()}\``,
      `- code: \`${data.code ?? "UNKNOWN"}\``,
      `- message: ${data.message ?? "unknown error"}`,
    ].join("\n")
  }

  if (data.status === "accepted") {
    return [
      COMMENT_MARKER,
      `Traffic-controller ${heading} by @${params.actorLogin} accepted.`,
      "",
      `- command: \`${params.commandBody.trim()}\``,
      `- operation: \`${data.operationId}\``,
      ...(data.resourceId ? [`- resource: \`${data.resourceId}\``] : []),
    ].join("\n")
  }

  const operation = data.operation
  return [
    COMMENT_MARKER,
    `Traffic-controller ${heading} by @${params.actorLogin}: \`${operation?.status ?? "unknown"}\`.`,
    "",
    `- command: \`${params.commandBody.trim()}\``,
    ...(operation?.operationId ? [`- operation: \`${operation.operationId}\``] : []),
    ...(operation?.leaseId ? [`- lease: \`${operation.leaseId}\``] : []),
    ...(operation?.routeableDeploymentId
      ? [`- deployment: \`${operation.routeableDeploymentId}\``]
      : []),
    ...(operation?.resultCode ? [`- code: \`${operation.resultCode}\``] : []),
    ...(operation?.resultMessage ? [`- message: ${operation.resultMessage}`] : []),
    ...(operation?.output ? ["", "```json", JSON.stringify(operation.output, null, 2), "```"] : []),
  ].join("\n")
}

async function githubApi<T>(repo: string, path: string, init?: RequestInit): Promise<T> {
  const token = requireEnv("GH_TOKEN")
  const headers = new Headers(init?.headers)
  headers.set("Accept", "application/vnd.github+json")
  headers.set("Authorization", `Bearer ${token}`)
  headers.set("X-GitHub-Api-Version", "2022-11-28")
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed with status ${response.status}`)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

async function findExistingMarkedComment(
  repo: string,
  prNumber: number,
): Promise<number | undefined> {
  let page = 1
  while (true) {
    const comments = await githubApi<Array<{ id: number; body?: string }>>(
      repo,
      `/issues/${prNumber}/comments?per_page=100&page=${page}`,
    )

    for (const comment of comments) {
      if (comment.body?.includes(COMMENT_MARKER)) {
        return comment.id
      }
    }

    if (comments.length < 100) {
      return undefined
    }

    page += 1
  }
}

async function postPrComment(repo: string, prNumber: number, body: string): Promise<void> {
  const existingCommentId = await findExistingMarkedComment(repo, prNumber)

  if (existingCommentId) {
    await githubApi(repo, `/issues/comments/${existingCommentId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    })
    return
  }

  await githubApi(repo, `/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  })
}

async function waitForFinalOperation(
  initial: TrafficControllerResponse,
): Promise<TrafficControllerResponse> {
  if (initial.data.status !== "accepted" || !initial.data.operationId) {
    return initial
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(2000)
    const poll = await invokeTrafficController({
      command: "get_operation",
      operationId: initial.data.operationId,
    })

    const status = poll.data.operation?.status
    if (status === "succeeded" || status === "failed" || status === "rejected") {
      return poll
    }
  }

  return initial
}

async function main(): Promise<void> {
  const commentBody = requireEnv("TRAFFIC_CONTROLLER_COMMENT_BODY")
  const actorLogin = requireEnv("TRAFFIC_CONTROLLER_ACTOR_LOGIN")
  const actorId = Number(requireEnv("TRAFFIC_CONTROLLER_ACTOR_ID"))
  const prNumber = Number(requireEnv("TRAFFIC_CONTROLLER_PR_NUMBER"))
  const repo = requireEnv("TRAFFIC_CONTROLLER_REPOSITORY")
  const commentId = requireEnv("TRAFFIC_CONTROLLER_COMMENT_ID")
  const targetInstallationId = Number(requireEnv("TRAFFIC_CONTROLLER_TARGET_INSTALLATION_ID"))
  const targetRepositoryId = Number(requireEnv("TRAFFIC_CONTROLLER_TARGET_REPOSITORY_ID"))

  const parsed = parseTrafficControllerComment(commentBody)
  const requestId = `comment-${commentId}`
  const deploymentId =
    parsed.target === "this_preview"
      ? buildDefaultDeploymentId({ prNumber, actorLogin })
      : parsed.target.deploymentId

  const response = await invokeTrafficController({
    command: "ensure_live_webhook_lease",
    requestId,
    actorGithubUserId: actorId,
    actorGithubLogin: actorLogin,
    prNumber,
    deploymentId,
    desiredState: parsed.desiredState,
    scope: {
      event: parsed.event,
      installationId: targetInstallationId,
      repositoryId: targetRepositoryId,
      action: parsed.action,
    },
    reason: `via PR comment by ${actorLogin}`,
  })

  const finalResponse = await waitForFinalOperation(response)
  const body = formatOperationComment({
    actorLogin,
    prNumber,
    desiredState: parsed.desiredState,
    commandBody: commentBody,
    response: finalResponse,
  })

  await postPrComment(repo, prNumber, body)
}

await main()
import { setTimeout as sleep } from "node:timers/promises"
