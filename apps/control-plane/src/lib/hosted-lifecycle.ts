import { randomBytes } from "node:crypto"

import {
  type LifecycleHook,
  matchEnvironmentPattern,
} from "./config-toml.ts"
import { getEnv } from "./env.ts"
import { buildHostedLifecyclePayload } from "./hosted-lifecycle-payload.ts"
import {
  createLifecycleEvent,
  createLifecycleItem,
  createLifecycleRun,
  findLifecycleItemById,
  findLifecycleRunById,
  findLifecycleRunByRunGroupId,
  issueLifecycleCompletionToken,
  listLifecycleItemsForRun,
  updateLifecycleItem,
  updateLifecycleRun,
} from "../db/queries/lifecycle.ts"
import { findPrincipalById, findPrincipalRepoBindingById } from "../db/queries/principals.ts"
import { findRepoByFullName } from "../db/queries/repositories.ts"
import { findRunGroupById } from "../db/queries/run-groups.ts"
import {
  findDeploymentById,
  transitionDeploymentStatus,
} from "../db/queries/workspace-deployments.ts"
import { getInstallationOctokit } from "./github.ts"
import { findConnectionsByName } from "../db/queries/connections.ts"
import { getConnectionScopeConfig, scopeListAllows } from "./connection-scope.ts"
import { assumeOrgBrokerRole } from "./org-broker-auth.ts"
import { getConnectionSecret } from "./connection-secrets.ts"
import { createHmac } from "node:crypto"
import { findOrgById } from "../db/queries/organizations.ts"
import { cascadeFailure, notifyDownstreams } from "./deployment-side-effects.ts"
import { deriveLifecycleConditions, deriveWorkspaceLifecycleState } from "./lifecycle-conditions.ts"
import {
  ExecutionContextAssociationError,
  findExecutionSnapshotWorkspace,
  isExecutionContextAssociationValid,
} from "./execution-snapshot.ts"

export interface HostedLifecycleExecutionResult {
  runId: string | null
}

export async function executeHostedLifecycleForDeployment(values: {
  runGroupId: string | null
  deployment: {
    id: string
    orgId: string
    repo: string
    environmentKind: "named" | "transient"
    environmentName: string
    workspacePath: string
    installationId?: number | null
  }
  outputs: Record<string, unknown>
}): Promise<HostedLifecycleExecutionResult> {
  if (!values.runGroupId) {
    throw new ExecutionContextAssociationError(
      `Deployment ${values.deployment.id} is missing its execution run group`,
    )
  }

  const runGroup = await findRunGroupById(values.runGroupId)
  if (!runGroup?.repoBindingId || !runGroup.executionSnapshot) {
    throw new ExecutionContextAssociationError(
      `Run group ${values.runGroupId} is missing its immutable execution context`,
    )
  }
  if (runGroup.orgId !== values.deployment.orgId) {
    throw new ExecutionContextAssociationError(
      `Run group ${runGroup.id} does not own deployment ${values.deployment.id}`,
    )
  }

  const binding = await findPrincipalRepoBindingById(runGroup.repoBindingId)
  if (!binding) {
    throw new Error(`run group ${runGroup.id} is missing its principal repo binding`)
  }
  if (!isExecutionContextAssociationValid({
    snapshot: runGroup.executionSnapshot,
    runGroup,
    resource: values.deployment,
    canonicalRepoNamespace: binding.canonicalRepoNamespace,
    requireRepoBinding: true,
  })) {
    throw new ExecutionContextAssociationError(
      `Run group ${runGroup.id} does not own deployment ${values.deployment.id}`,
    )
  }
  const principal = await findPrincipalById(binding.principalId)
  if (!principal) {
    throw new Error(`principal ${binding.principalId} for run group ${runGroup.id} was not found`)
  }

  const executionSnapshot = runGroup.executionSnapshot
  const workspace = findExecutionSnapshotWorkspace(
    executionSnapshot,
    values.deployment.workspacePath,
  )
  if (!workspace) {
    throw new ExecutionContextAssociationError(
      `Run group ${runGroup.id} does not contain workspace ${values.deployment.workspacePath}`,
    )
  }

  const canonicalRepoNamespace = binding.canonicalRepoNamespace
  const environmentName = executionSnapshot.environment.name
  const source = executionSnapshot.source

  const activationHooks = lifecycleHooksForEnvironment(workspace.lifecycle.activation, environmentName)
  const verificationHooks = lifecycleHooksForEnvironment(workspace.lifecycle.verification, environmentName)
  if (activationHooks.length === 0 && verificationHooks.length === 0) {
    return { runId: null }
  }

  let lifecycleRun = await findLifecycleRunByRunGroupId(runGroup.id)
  if (!lifecycleRun) {
    lifecycleRun = await createLifecycleRun({
      principalId: principal.id,
      runGroupId: runGroup.id,
      repoBindingId: binding.id,
      environmentName,
      executionMode: "cloud",
      status: "running",
    })
  }

  const pendingDispatches: Array<{ itemId: string }> = []

  for (const hook of activationHooks) {
    const item = await createHostedLifecycleItem({
      runId: lifecycleRun.id,
      workspacePath: values.deployment.workspacePath,
      phase: "activation",
      hook,
      environmentName,
      canonicalRepoNamespace,
      ref: source.ref,
      headSha: source.commitSha,
      baseSha: source.baseSha ?? undefined,
      installationId: source.installationId,
      outputs: values.outputs,
    })
    pendingDispatches.push({ itemId: item.id })
  }

  for (const hook of verificationHooks) {
    await createHostedLifecycleItem({
      runId: lifecycleRun.id,
      workspacePath: values.deployment.workspacePath,
      phase: "verification",
      hook,
      environmentName,
      canonicalRepoNamespace,
      ref: source.ref,
      headSha: source.commitSha,
      baseSha: source.baseSha ?? undefined,
      installationId: source.installationId,
      outputs: values.outputs,
    })
  }

  if (pendingDispatches.length === 0 && verificationHooks.length > 0) {
    const items = await listLifecycleItemsForRun(lifecycleRun.id)
    for (const item of items.filter((entry) => entry.workspacePath === values.deployment.workspacePath && entry.phase === "verification")) {
      pendingDispatches.push({ itemId: item.id })
    }
  }

  for (const pending of pendingDispatches) {
    await dispatchHostedLifecycleItem(pending.itemId)
  }

  return { runId: lifecycleRun.id }
}

export async function reconcileHostedDeploymentState(values: {
  deploymentId: string
  workspacePath: string
  lifecycleRunId: string | null
  runGroupId: string | null
}): Promise<void> {
  const deployment = await findDeploymentById(values.deploymentId)
  if (!deployment || deployment.status === "destroyed") {
    return
  }

  const workspaceItems = values.lifecycleRunId
    ? (await listLifecycleItemsForRun(values.lifecycleRunId)).filter((item) => item.workspacePath === values.workspacePath)
    : []

  const workspaceState = deriveWorkspaceLifecycleState(
    workspaceItems.map((item) => ({
      workspacePath: item.workspacePath,
      phase: item.phase,
      state: item.state,
      scopes: item.scopes,
    })),
  )
  const conditions = deriveLifecycleConditions(
    workspaceItems.map((item) => ({
      workspacePath: item.workspacePath,
      phase: item.phase,
      state: item.state,
      scopes: item.scopes,
    })),
  )

  if (conditions.infra_ready.met) {
    await notifyDownstreams(deployment.id, "apply", values.runGroupId)
  }

  const infraDagFailed = conditions.infra_ready.vector.degraded > 0
    || conditions.infra_ready.vector.blocked > 0
    || conditions.infra_ready.vector.failed > 0

  if (workspaceState.deploymentStatus === "failed") {
    const updated = await transitionDeploymentStatus(
      deployment.id,
      ["planning", "applying", "activating", "ready"],
      "failed",
    )
    if (updated && infraDagFailed) {
      await cascadeFailure(deployment.id)
    }
    return
  }

  if (workspaceState.deploymentStatus === "activating") {
    await transitionDeploymentStatus(
      deployment.id,
      ["planning", "applying"],
      "activating",
    )
    return
  }

  await transitionDeploymentStatus(
    deployment.id,
    ["planning", "applying", "activating"],
    "ready",
  )
  if (infraDagFailed) {
    await cascadeFailure(deployment.id)
  }
}

export async function dispatchHostedLifecycleVerificationIfReady(values: {
  runId: string
  workspacePath: string
}): Promise<void> {
  const items = await listLifecycleItemsForRun(values.runId)
  const workspaceItems = items.filter((item) => item.workspacePath === values.workspacePath)
  const activationItems = workspaceItems.filter((item) => item.phase === "activation")
  if (activationItems.some((item) => item.state === "failed")) {
    return
  }
  if (activationItems.some((item) => item.state === "pending" || item.state === "running")) {
    return
  }

  for (const item of workspaceItems.filter((entry) => entry.phase === "verification" && entry.state === "pending")) {
    await dispatchHostedLifecycleItem(item.id)
  }
}

async function createHostedLifecycleItem(values: {
  runId: string
  workspacePath: string
  phase: "activation" | "verification"
  hook: LifecycleHook
  environmentName: string
  canonicalRepoNamespace: string
  ref: string
  headSha: string
  baseSha?: string
  installationId: number
  outputs: Record<string, unknown>
}) {
  const destination = hostedLifecycleDestination(values.hook, values.canonicalRepoNamespace)
  const item = await createLifecycleItem({
    runId: values.runId,
    workspacePath: values.workspacePath,
    key: values.hook.key,
    phase: values.phase,
    kind: "webhook",
    state: "pending",
    failurePolicy: values.hook.failure,
    scopes: values.hook.scopes,
    destinationUrl: destination.url,
    destinationClass: destination.class,
    dispatchMode: "cloud",
    summary: values.phase === "activation"
      ? "Waiting for hosted activation dispatch"
      : "Waiting for hosted verification dispatch",
    metadata: {
      hostedDispatch: serializeHostedDispatch(values.hook, values.installationId),
      hostedPayload: buildHostedLifecyclePayload({
        canonicalRepoNamespace: values.canonicalRepoNamespace,
        environmentName: values.environmentName,
        workspacePath: values.workspacePath,
        itemKey: values.hook.key,
        phase: values.phase,
        outputs: values.outputs,
        headSha: values.headSha,
        branch: stripGitBranch(values.ref),
        baseSha: values.baseSha,
      }),
      callbackTtlMinutes: 60,
    },
  })

  await createLifecycleEvent({
    itemId: item.id,
    eventType: "created",
    payload: {
      workspacePath: values.workspacePath,
      key: values.hook.key,
      phase: values.phase,
      origin: "hosted",
    },
  })

  return item
}

async function dispatchHostedLifecycleItem(itemId: string): Promise<void> {
  const item = await findLifecycleItemById(itemId)
  if (!item || item.state !== "pending") {
    return
  }
  const run = await findLifecycleRunById(item.runId)
  if (!run) {
    throw new Error(`lifecycle run not found for item ${item.id}`)
  }

  const metadata = item.metadata as {
    hostedDispatch?: HostedDispatchSpec
    hostedPayload?: Record<string, unknown>
    callbackTtlMinutes?: number
  }
  if (!metadata.hostedDispatch || !metadata.hostedPayload) {
    throw new Error(`hosted lifecycle item ${item.id} is missing dispatch metadata`)
  }

  const callbackToken = randomBytes(32).toString("base64url")
  await issueLifecycleCompletionToken({
    token: callbackToken,
    itemId: item.id,
    expiresAt: new Date(Date.now() + (metadata.callbackTtlMinutes ?? 60) * 60 * 1000),
  })

  const dispatchPayload = {
    ...metadata.hostedPayload,
    on_completion: new URL(`/api/lifecycle/completions/${callbackToken}`, getEnv().publicApiUrl).toString(),
  }

  try {
    await dispatchHostedLifecycle(metadata.hostedDispatch, dispatchPayload)
    await updateLifecycleItem(item.id, {
      state: "running",
      summary: item.phase === "activation"
        ? "Dispatching hosted activation hook"
        : "Dispatching hosted verification hook",
      startedAt: item.startedAt ?? new Date(),
    })
    await createLifecycleEvent({
      itemId: item.id,
      eventType: "dispatched",
      payload: {
        kind: metadata.hostedDispatch.kind,
        workspacePath: item.workspacePath,
        phase: item.phase,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateLifecycleItem(item.id, {
      state: "failed",
      summary: `Dispatch failed for ${item.key}`,
      reason: message,
      startedAt: item.startedAt ?? new Date(),
      finishedAt: new Date(),
    })
    await createLifecycleEvent({
      itemId: item.id,
      eventType: "dispatch_failed",
      payload: {
        kind: metadata.hostedDispatch.kind,
        workspacePath: item.workspacePath,
        phase: item.phase,
        reason: message,
      },
    })
    await reconcileLifecycleRunStatus(run.id)
  }
}

async function reconcileLifecycleRunStatus(runId: string): Promise<void> {
  const run = await findLifecycleRunById(runId)
  if (!run) {
    return
  }

  const items = await listLifecycleItemsForRun(runId)
  const finalStatus = items.some((entry) => entry.state === "failed")
    ? "failed"
    : items.some((entry) => entry.state === "degraded")
      ? "degraded"
      : items.every((entry) => entry.state === "succeeded")
        ? "succeeded"
        : "running"

  await updateLifecycleRun(runId, {
    status: finalStatus,
    finishedAt: finalStatus === "running" ? null : new Date(),
  })
}

function lifecycleHooksForEnvironment(hooks: LifecycleHook[], environmentName: string): LifecycleHook[] {
  return hooks.filter((hook) => hook.environments.some((pattern) => matchEnvironmentPattern(pattern, environmentName)))
}

type HostedDispatchSpec =
  | { kind: "generic"; request: { url: string; method: "POST"; auth?: { scheme: "bearer" | "hmac_sha256"; connection: string } } }
  | { kind: "github_repository_dispatch"; github: { owner?: string; repo?: string; eventType: string; apiUrl?: string; installationId?: number } }

function serializeHostedDispatch(
  hook: LifecycleHook,
  producerInstallationId: number,
): HostedDispatchSpec {
  if (hook.kind === "github_repository_dispatch") {
    return {
      kind: "github_repository_dispatch",
      github: {
        owner: hook.github?.owner,
        repo: hook.github?.repo,
        eventType: hook.github?.event_type ?? hook.key,
        apiUrl: hook.github?.api_url,
        installationId: hook.github?.owner || hook.github?.repo
          ? undefined
          : producerInstallationId,
      },
    }
  }

  const auth = hook.request?.auth?.connection
    ? {
        scheme: hook.request.auth.scheme,
        connection: hook.request.auth.connection,
      }
    : undefined

  return {
    kind: "generic",
    request: {
      url: hook.request?.url ?? "",
      method: "POST",
      auth,
    },
  }
}

function hostedLifecycleDestination(hook: LifecycleHook, canonicalRepoNamespace: string): { url: string; class: "public" | "private_local" } {
  if (hook.kind === "github_repository_dispatch") {
    const [ownerFromNamespace, repoFromNamespace] = canonicalRepoNamespace.split("--")
    const owner = hook.github?.owner ?? ownerFromNamespace
    const repo = hook.github?.repo ?? repoFromNamespace
    const apiBase = hook.github?.api_url ?? "https://api.github.com"
    return {
      url: `${apiBase.replace(/\/$/, "")}/repos/${owner}/${repo}/dispatches`,
      class: "public",
    }
  }

  return {
    url: hook.request?.url ?? "",
    class: classifyDestinationUrl(hook.request?.url ?? ""),
  }
}

async function dispatchHostedLifecycle(spec: HostedDispatchSpec, payload: Record<string, unknown>): Promise<void> {
  if (spec.kind === "github_repository_dispatch") {
    const target = resolveGitHubDispatchTarget(spec.github, payload.repo_namespace)
    const repo = await findRepoByFullName(`${target.owner}/${target.repo}`)
    const installationId = spec.github.installationId ?? repo?.installationId
    if (!installationId) {
      throw new Error(`GitHub App installation is not configured for ${target.owner}/${target.repo}`)
    }
    const octokit = await getInstallationOctokit(installationId)
    await octokit.request("POST /repos/{owner}/{repo}/dispatches", {
      owner: target.owner,
      repo: target.repo,
      event_type: spec.github.eventType,
      client_payload: { yaffle: payload },
    })
    return
  }

  const headers = new Headers({ "content-type": "application/json" })
  if (spec.request.auth?.connection) {
    const repoNamespace = payload.repo_namespace
    const environment = payload.environment
    const workspacePath = payload.workspace_path
    if (
      typeof repoNamespace !== "string"
      || typeof environment !== "string"
      || typeof workspacePath !== "string"
    ) {
      throw new Error("Lifecycle payload is missing its execution scope")
    }
    const secret = await resolveLifecycleConnectionSecret(
      repoNamespace,
      environment,
      workspacePath,
      spec.request.auth.connection,
    )
    applyLifecycleConnectionAuth(headers, spec.request.auth.scheme, secret, Buffer.from(JSON.stringify(payload)))
  }

  const response = await fetch(spec.request.url, {
    method: spec.request.method,
    headers,
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`Lifecycle webhook returned ${response.status}`)
  }
}

function stripGitBranch(ref: string): string | null {
  return ref.startsWith("refs/heads/") ? ref.replace(/^refs\/heads\//, "") : null
}

function classifyDestinationUrl(url: string): "public" | "private_local" {
  return url.includes("127.0.0.1") || url.includes("localhost") || url.includes(".local")
    ? "private_local"
    : "public"
}

function resolveGitHubDispatchTarget(
  github: { owner?: string; repo?: string },
  canonicalRepoNamespaceValue: unknown,
): { owner: string; repo: string } {
  const canonicalRepoNamespace = typeof canonicalRepoNamespaceValue === "string" ? canonicalRepoNamespaceValue : ""
  const explicitOwner = github.owner?.trim()
  const explicitRepo = github.repo?.trim()
  if (explicitOwner && explicitRepo) {
    return { owner: explicitOwner, repo: explicitRepo }
  }
  const [owner, repo] = canonicalRepoNamespace.split("--")
  if (!owner || !repo) {
    throw new Error(`Could not resolve repository from namespace '${canonicalRepoNamespace}'`)
  }
  return { owner, repo }
}

async function resolveLifecycleConnectionSecret(
  canonicalRepoNamespace: string,
  environmentName: string,
  workspacePath: string,
  connectionName: string,
): Promise<string> {
  const repoFullName = canonicalRepoNamespace.replace("--", "/")
  const repo = await findRepoByFullName(repoFullName)
  if (!repo?.orgId) {
    throw new Error(`Repository '${repoFullName}' is not linked to a Yaffle organization`)
  }

  const matches = (await findConnectionsByName(repo.orgId, connectionName)).filter((connection) => {
    const scope = getConnectionScopeConfig(connection)
    return scopeListAllows(scope.environmentScope, environmentName)
      && scopeListAllows(scope.workspaceScope, workspacePath)
  })

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one connection named '${connectionName}' for ${environmentName} / ${workspacePath}`)
  }

  const connection = matches[0]
  if (connection.credentialProviderType !== "envvar" || !connection.secretPath) {
    throw new Error(`Connection '${connection.name}' must be an envvar-backed connection for lifecycle auth`)
  }
  const org = await findOrgById(connection.orgId)
  if (!org?.iamRoleArn) {
    throw new Error(`Organization for connection '${connection.name}' is missing broker role configuration`)
  }
  const brokerCredentials = await assumeOrgBrokerRole(connection.orgId, org.iamRoleArn)
  const secret = await getConnectionSecret(connection.secretPath, { credentials: brokerCredentials }) as {
    envVars?: Array<{ key?: string; value?: string }>
  }
  const envVars = (secret.envVars ?? []).filter((entry): entry is { key: string; value: string } =>
    typeof entry.key === "string" && typeof entry.value === "string" && entry.key.length > 0,
  )
  if (envVars.length !== 1) {
    throw new Error(`Connection '${connection.name}' must contain exactly one env var secret for lifecycle auth`)
  }
  return envVars[0].value
}

function applyLifecycleConnectionAuth(
  headers: Headers,
  scheme: "bearer" | "hmac_sha256",
  secret: string,
  body: Buffer,
): void {
  if (scheme === "bearer") {
    headers.set("authorization", `Bearer ${secret}`)
    return
  }

  const signature = createHmac("sha256", secret).update(body).digest("hex")
  headers.set("X-Yaffle-Signature", `sha256=${signature}`)
}
