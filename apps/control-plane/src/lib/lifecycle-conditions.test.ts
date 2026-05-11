import { describe, expect, test } from "@yaffle/test"

import {
  deriveLifecycleConditions,
  deriveRunGroupLifecycleState,
  deriveWorkspaceLifecycleState,
} from "./lifecycle-conditions.ts"

describe("deriveWorkspaceLifecycleState", () => {
  test("keeps deployment activating while usable scope is still progressing", () => {
    const state = deriveWorkspaceLifecycleState([
      {
        workspacePath: "apps/web/infra",
        phase: "activation",
        state: "running",
        scopes: ["usable"],
      },
    ])

    expect(state.deploymentStatus).toBe("activating")
    expect(state.conditions.usable.met).toBe(false)
    expect(state.conditions.usable.summary).toBe("progressing")
  })

  test("marks deployment ready once usable is met even if acceptable is still progressing", () => {
    const state = deriveWorkspaceLifecycleState([
      {
        workspacePath: "apps/web/infra",
        phase: "activation",
        state: "succeeded",
        scopes: ["usable", "acceptable"],
      },
      {
        workspacePath: "apps/web/infra",
        phase: "verification",
        state: "running",
        scopes: ["acceptable"],
      },
    ])

    expect(state.deploymentStatus).toBe("ready")
    expect(state.conditions.usable.met).toBe(true)
    expect(state.conditions.acceptable.met).toBe(false)
  })

  test("does not demote usable readiness for degraded acceptable work", () => {
    const state = deriveWorkspaceLifecycleState([
      {
        workspacePath: "apps/web/infra",
        phase: "activation",
        state: "degraded",
        scopes: ["usable"],
      },
      {
        workspacePath: "apps/web/infra",
        phase: "verification",
        state: "degraded",
        scopes: ["acceptable"],
      },
    ])

    expect(state.deploymentStatus).toBe("ready")
    expect(state.conditions.usable.met).toBe(true)
    expect(state.conditions.acceptable.met).toBe(false)
    expect(state.conditions.acceptable.summary).toBe("degraded")
  })

  test("fails deployment when usable scope fails", () => {
    const state = deriveWorkspaceLifecycleState([
      {
        workspacePath: "apps/web/infra",
        phase: "activation",
        state: "failed",
        scopes: ["usable"],
      },
    ])

    expect(state.deploymentStatus).toBe("failed")
  })
})

describe("deriveRunGroupLifecycleState", () => {
  test("stays running until acceptable work settles", () => {
    const state = deriveRunGroupLifecycleState({
      deployments: [{ workspacePath: "apps/web/infra", status: "ready" }],
      items: [
        {
          workspacePath: "apps/web/infra",
          phase: "activation",
          state: "succeeded",
          scopes: ["usable", "acceptable"],
        },
        {
          workspacePath: "apps/web/infra",
          phase: "verification",
          state: "running",
          scopes: ["acceptable"],
        },
      ],
    })

    expect(state).toEqual({ status: "running", isComplete: false })
  })

  test("returns partial when acceptable settles degraded", () => {
    const state = deriveRunGroupLifecycleState({
      deployments: [{ workspacePath: "apps/web/infra", status: "ready" }],
      items: [
        {
          workspacePath: "apps/web/infra",
          phase: "activation",
          state: "succeeded",
          scopes: ["usable"],
        },
        {
          workspacePath: "apps/web/infra",
          phase: "verification",
          state: "degraded",
          scopes: ["acceptable"],
        },
      ],
    })

    expect(state).toEqual({ status: "partial", isComplete: true })
  })

  test("returns failed when acceptable fails after deployment becomes ready", () => {
    const state = deriveRunGroupLifecycleState({
      deployments: [{ workspacePath: "apps/web/infra", status: "ready" }],
      items: [
        {
          workspacePath: "apps/web/infra",
          phase: "activation",
          state: "succeeded",
          scopes: ["usable"],
        },
        {
          workspacePath: "apps/web/infra",
          phase: "verification",
          state: "failed",
          scopes: ["acceptable"],
        },
      ],
    })

    expect(state).toEqual({ status: "failed", isComplete: true })
  })
})

describe("deriveLifecycleConditions", () => {
  test("treats empty scoped sets as met but idle", () => {
    const conditions = deriveLifecycleConditions([])

    expect(conditions.infra_ready.met).toBe(true)
    expect(conditions.infra_ready.summary).toBe("idle")
    expect(conditions.usable.met).toBe(true)
    expect(conditions.usable.summary).toBe("idle")
    expect(conditions.acceptable.met).toBe(true)
    expect(conditions.acceptable.summary).toBe("idle")
  })

  test("does not block infra progression for activation without infra_dag scope", () => {
    const conditions = deriveLifecycleConditions([
      {
        workspacePath: "apps/web/infra",
        phase: "activation",
        state: "running",
        scopes: ["usable"],
      },
    ])

    expect(conditions.infra_ready.met).toBe(true)
    expect(conditions.infra_ready.summary).toBe("idle")
  })

  test("blocks infra progression when a hook explicitly opts into infra_dag", () => {
    const conditions = deriveLifecycleConditions([
      {
        workspacePath: "apps/web/infra",
        phase: "activation",
        state: "running",
        scopes: ["usable", "infra_dag"],
      },
    ])

    expect(conditions.infra_ready.met).toBe(false)
    expect(conditions.infra_ready.summary).toBe("progressing")
  })

  test("treats degraded infra_dag work as blocking", () => {
    const conditions = deriveLifecycleConditions([
      {
        workspacePath: "apps/web/infra",
        phase: "verification",
        state: "degraded",
        scopes: ["infra_dag"],
      },
    ])

    expect(conditions.infra_ready.met).toBe(false)
    expect(conditions.infra_ready.summary).toBe("degraded")
  })
})
