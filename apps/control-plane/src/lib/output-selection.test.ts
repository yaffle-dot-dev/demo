import { describe, expect, test } from "@yaffle/test"

import {
  OutputSelectionError,
  redactSensitiveOutputValues,
  selectSharedOutputSnapshotValues,
  selectTerraformOutputs,
} from "./output-selection.ts"

const outputs = {
  endpoint: { value: "https://api.example.test", type: "string", sensitive: false },
  password: { value: "do-not-expose", type: "string", sensitive: true },
  internal_id: { value: "private-id", type: "string", sensitive: false },
}

describe("selectTerraformOutputs", () => {
  test("redacts sensitive values for an authorized viewer", () => {
    expect(
      selectTerraformOutputs({
        outputs,
        selection: { kind: "all" },
        sensitive: "redact",
      }),
    ).toEqual({
      endpoint: { value: "https://api.example.test", type: "string", sensitive: false },
      password: { value: null, type: "string", sensitive: true },
      internal_id: { value: "private-id", type: "string", sensitive: false },
    })
  })

  test("allows only outputs explicitly selected by immutable workspace policy", () => {
    expect(
      selectTerraformOutputs({
        outputs,
        selection: {
          kind: "policy",
          policies: {
            endpoint: { visibility: "internal" },
            password: { visibility: "internal" },
          },
        },
        sensitive: "redact",
      }),
    ).toEqual({
      endpoint: { value: "https://api.example.test", type: "string", sensitive: false },
      password: { value: null, type: "string", sensitive: true },
    })
  })

  test("rejects sensitive values from external publication with remediation", () => {
    expect(() =>
      selectTerraformOutputs({
        outputs,
        selection: { kind: "names", names: ["endpoint", "password"] },
        sensitive: "reject",
      }),
    ).toThrowError(
      new OutputSelectionError(
        "SENSITIVE_OUTPUT_NOT_ALLOWED",
        "Sensitive Terraform outputs cannot cross this trust boundary: password. Store the secret in a secret manager and export only its ARN or identifier.",
        ["password"],
      ),
    )
  })

  test("fails closed when a selected output has no sensitivity metadata", () => {
    expect(() =>
      selectTerraformOutputs({
        outputs: { endpoint: "https://api.example.test" },
        selection: { kind: "all" },
        sensitive: "redact",
      }),
    ).toThrowError(/endpoint.*valid Terraform output/i)
  })
})

describe("redactSensitiveOutputValues", () => {
  test("withholds logs when a run produced any sensitive output", () => {
    expect(
      redactSensitiveOutputValues(
        'apply complete password=do-not-expose credentials={"token":"nested-secret"} token=nested-secret',
        {
          endpoint: { value: "https://api.example.test", sensitive: false },
          password: { value: "do-not-expose", sensitive: true },
          credentials: { value: { token: "nested-secret" }, sensitive: true },
        },
      ),
    ).toBe("[Log output withheld because this run produced sensitive Terraform outputs]")
  })

  test("withholds logs when output metadata is unavailable", () => {
    expect(redactSensitiveOutputValues("potentially sensitive", null)).toBeNull()
  })
})

describe("selectSharedOutputSnapshotValues", () => {
  test("builds selected structurally redacted snapshot values", () => {
    expect(
      selectSharedOutputSnapshotValues(outputs, {
        endpoint: { visibility: "public", consumers: ["acme:app:infra"] },
        password: { visibility: "internal" },
      }),
    ).toEqual({
      endpoint: { value: "https://api.example.test", sensitive: false },
      password: { value: null, sensitive: true },
    })
  })
})
