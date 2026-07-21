import type { WorkspaceOutputPolicy } from "./config-toml.ts"

export interface TerraformOutput {
  value: unknown
  type?: unknown
  sensitive: boolean
}

export type OutputSelection =
  | { kind: "all" }
  | { kind: "policy"; policies: Record<string, WorkspaceOutputPolicy> }
  | { kind: "names"; names: string[] }

export class OutputSelectionError extends Error {
  constructor(
    public readonly code: "INVALID_TERRAFORM_OUTPUT" | "SENSITIVE_OUTPUT_NOT_ALLOWED",
    message: string,
    public readonly outputNames: string[],
  ) {
    super(message)
    this.name = "OutputSelectionError"
  }
}

function selectedNames(selection: OutputSelection, outputs: Record<string, unknown>): string[] {
  if (selection.kind === "all") {
    return Object.keys(outputs).sort()
  }

  const configuredNames =
    selection.kind === "policy" ? Object.keys(selection.policies) : selection.names
  const availableNames = new Set(Object.keys(outputs))
  return [...new Set(configuredNames)].filter((name) => availableNames.has(name)).sort()
}

function parseTerraformOutput(name: string, value: unknown): TerraformOutput {
  if (
    !value ||
    typeof value !== "object" ||
    !("value" in value) ||
    !("sensitive" in value) ||
    typeof (value as { sensitive?: unknown }).sensitive !== "boolean"
  ) {
    throw new OutputSelectionError(
      "INVALID_TERRAFORM_OUTPUT",
      `Output ${name} is not a valid Terraform output with explicit sensitivity metadata`,
      [name],
    )
  }

  return value as TerraformOutput
}

export function selectTerraformOutputs(values: {
  outputs: Record<string, unknown> | null
  selection: OutputSelection
  sensitive: "preserve" | "redact" | "reject"
}): Record<string, TerraformOutput> | null {
  if (!values.outputs) {
    return null
  }

  const selected = selectedNames(values.selection, values.outputs).map(
    (name) => [name, parseTerraformOutput(name, values.outputs![name])] as const,
  )
  const sensitiveNames = selected
    .filter(([, output]) => output.sensitive === true)
    .map(([name]) => name)

  if (values.sensitive === "reject" && sensitiveNames.length > 0) {
    throw new OutputSelectionError(
      "SENSITIVE_OUTPUT_NOT_ALLOWED",
      `Sensitive Terraform outputs cannot cross this trust boundary: ${sensitiveNames.join(", ")}. Store the secret in a secret manager and export only its ARN or identifier.`,
      sensitiveNames,
    )
  }

  return Object.fromEntries(
    selected.map(([name, output]) => [
      name,
      output.sensitive === true && values.sensitive === "redact"
        ? { ...output, value: null }
        : structuredClone(output),
    ]),
  )
}

export function redactSensitiveOutputValues(
  logOutput: string | null | undefined,
  outputs: Record<string, unknown> | null | undefined,
): string | null {
  if (!logOutput || !outputs) {
    return null
  }

  const parsedOutputs = Object.entries(outputs).map(([name, value]) =>
    parseTerraformOutput(name, value),
  )
  return parsedOutputs.some((output) => output.sensitive)
    ? "[Log output withheld because this run produced sensitive Terraform outputs]"
    : logOutput
}

export function selectSharedOutputSnapshotValues(
  outputs: Record<string, unknown> | null,
  policies: Record<string, WorkspaceOutputPolicy>,
): Record<string, { value: unknown; sensitive: false } | { value: null; sensitive: true }> {
  const selected = selectTerraformOutputs({
    outputs,
    selection: { kind: "policy", policies },
    sensitive: "redact",
  })

  return Object.fromEntries(
    Object.entries(selected ?? {}).map(([name, output]) => [
      name,
      output.sensitive === true
        ? { value: null, sensitive: true as const }
        : { value: output.value, sensitive: false as const },
    ]),
  )
}
