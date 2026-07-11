import { describe, expect, test } from "@yaffle/test"

import type { Workspace as TfcWorkspace } from "../db/queries/workspaces.ts"

import { parseYaffleToml } from "./config-toml.ts"
import {
  filterOutputsForAccess,
  findSensitiveExportedOutputs,
  resolveModuleAccessDecision,
  type ModuleConsumerWorkspace,
} from "./workspace-exports.ts"

function makeWorkspace(overrides: Partial<TfcWorkspace> = {}): TfcWorkspace {
  return {
    id: "ws-producer",
    orgId: "org-producer",
    name: "producer-workspace",
    repo: "yaffle-dot-dev/platform",
    workspacePath: "platform/eks",
    environmentKind: "named",
    environmentName: "main",
    ref: "refs/heads/main",
    locked: false,
    lockedBy: null,
    lockedAt: null,
    lockReason: null,
    lockId: null,
    currentStateVersionId: null,
    terraformVersion: null,
    status: "active",
    createdAt: new Date(),
    ...overrides,
  }
}

function makeConsumer(overrides: Partial<ModuleConsumerWorkspace> = {}): ModuleConsumerWorkspace {
  return {
    orgId: "org-producer",
    orgSlug: "acme",
    repo: "yaffle-dot-dev/applications",
    workspacePath: "apps/api/infra",
    environmentKind: "named",
    environmentName: "main",
    ...overrides,
  }
}

function makeCrossOrgConsumer(overrides: Partial<ModuleConsumerWorkspace> = {}): ModuleConsumerWorkspace {
  return makeConsumer({
    orgId: "org-consumer",
    orgSlug: "consumer-org",
    repo: "other-org/foo-service",
    ...overrides,
  })
}

describe("resolveModuleAccessDecision", () => {
  test("allows legacy user-token access when no output policies exist", () => {
    const decision = resolveModuleAccessDecision({
      authType: "user",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "missing",
      producerConfig: null,
      consumerWorkspace: null,
    })

    expect(decision).toEqual({
      allowed: true,
      allowedOutputs: null,
    })
  })

  test("allows same-repo workspace consumers to read all outputs", () => {
    const producerWorkspace = makeWorkspace()
    const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["consumer-org:yaffle-dot-dev/applications:apps/*"] }
`)

    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace,
      producerConfigState: "loaded",
      producerConfig: config,
      consumerWorkspace: makeConsumer({
        orgId: producerWorkspace.orgId,
        orgSlug: "acme",
        repo: "yaffle-dot-dev/platform",
        workspacePath: "apps/web/infra",
      }),
    })

    expect(decision).toEqual({
      allowed: true,
      allowedOutputs: null,
    })
  })

  test("denies cross-repo consumers when no output policies exist", () => {
    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "loaded",
      producerConfig: parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]
`),
      consumerWorkspace: makeConsumer(),
    })

    expect(decision.allowed).toBe(false)
    expect(decision.errorTitle).toMatch(/Module not exported/)
  })

  test("allows allowlisted cross-org consumers", () => {
    const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["consumer-org:other-org/foo-service:apps/*"] }
outputs.cluster_ca = { visibility = "public", consumers = ["consumer-org:other-org/foo-service:apps/*"] }
outputs.internal_secret_arn = { visibility = "internal" }
`)

    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "loaded",
      producerConfig: config,
      consumerWorkspace: makeCrossOrgConsumer(),
    })

    expect(decision).toEqual({
      allowed: true,
      allowedOutputs: ["cluster_ca", "cluster_endpoint"],
    })
  })

  test("denies user-token access for workspaces with explicit output policies", () => {
    const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["acme:yaffle-dot-dev/applications:apps/*"] }
`)

    const decision = resolveModuleAccessDecision({
      authType: "user",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "loaded",
      producerConfig: config,
      consumerWorkspace: null,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.errorTitle).toBe("Workspace-scoped token required")
  })

  test("denies external consumers that are not allowlisted", () => {
    const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["acme:yaffle-dot-dev/applications:services/*"] }
`)

    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "loaded",
      producerConfig: config,
      consumerWorkspace: makeConsumer(),
    })

    expect(decision.allowed).toBe(false)
    expect(decision.errorTitle).toMatch(/Module not exported/)
  })

  test("allows allowlisted cross-repo consumers in the same Yaffle org", () => {
    const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["acme:yaffle-dot-dev/applications:apps/*"] }
outputs.cluster_ca = { visibility = "public", consumers = ["acme:yaffle-dot-dev/applications:apps/*"] }
outputs.internal_secret_arn = { visibility = "internal" }
`)

    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "loaded",
      producerConfig: config,
      consumerWorkspace: makeConsumer(),
    })

    expect(decision).toEqual({
      allowed: true,
      allowedOutputs: ["cluster_ca", "cluster_endpoint"],
    })
  })

  test("denies cross-org consumers that are not allowlisted", () => {
    const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/eks"
environments = ["main"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["acme:yaffle-dot-dev/applications:apps/*"] }
`)

    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "loaded",
      producerConfig: config,
      consumerWorkspace: makeCrossOrgConsumer(),
    })

    expect(decision.allowed).toBe(false)
    expect(decision.errorTitle).toMatch(/Module not exported/)
  })

  test("denies run tokens whose consumer workspace cannot be resolved", () => {
    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "missing",
      producerConfig: null,
      consumerWorkspace: null,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.errorTitle).toBe("Consumer workspace not found")
  })

  test("denies external access when producer config cannot be loaded", () => {
    const decision = resolveModuleAccessDecision({
      authType: "run",
      producerWorkspace: makeWorkspace(),
      producerConfigState: "unavailable",
      producerConfig: null,
      consumerWorkspace: makeConsumer(),
    })

    expect(decision.allowed).toBe(false)
    expect(decision.errorTitle).toBe("Producer config unavailable")
  })
})

describe("output filtering", () => {
  const outputs = {
    cluster_endpoint: { value: "https://example", type: "string" },
    cluster_ca: { value: "base64", type: "string" },
    token: { value: "secret", type: "string", sensitive: true },
  }

  test("filters outputs to the authorized subset", () => {
    expect(filterOutputsForAccess(outputs, ["cluster_endpoint", "cluster_ca"]))
      .toEqual({
        cluster_endpoint: outputs.cluster_endpoint,
        cluster_ca: outputs.cluster_ca,
      })
  })

  test("detects sensitive outputs in the authorized public subset", () => {
    expect(findSensitiveExportedOutputs(outputs, ["cluster_endpoint", "token"]))
      .toEqual(["token"])
  })
})
