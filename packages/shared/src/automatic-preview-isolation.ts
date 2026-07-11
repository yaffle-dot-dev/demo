import * as hcl from "hcl2-parser"

export type AutomaticIsolationPreflightStatus = "ready" | "review_required" | "blocked"

export type AutomaticIsolationFindingCode =
  | "hcl_parse_error"
  | "import_not_allowed"
  | "module_review_required"
  | "prevent_destroy_not_allowed"
  | "provisioner_not_allowed"
  | "removed_not_allowed"
  | "resource_review_required"
  | "symlink_not_supported"
  | "tf_json_not_supported"

export interface AutomaticIsolationSourceFile {
  path: string
  content: string
}

export interface AutomaticIsolationFinding {
  code: AutomaticIsolationFindingCode
  filePath: string
  resourceAddress?: string
  message: string
}

export interface AutomaticIsolationWorkspacePreflight {
  workspacePath: string
  status: AutomaticIsolationPreflightStatus
  findings: AutomaticIsolationFinding[]
}

export interface AutomaticIsolationPreflight {
  status: AutomaticIsolationPreflightStatus
  workspaces: AutomaticIsolationWorkspacePreflight[]
}

interface ParsedHclDocument {
  import?: Array<Record<string, unknown>>
  module?: Record<string, Array<Record<string, unknown>>>
  removed?: Array<Record<string, unknown>>
  resource?: Record<string, Record<string, Array<Record<string, unknown>>>>
}

function inspectResource(
  filePath: string,
  resourceAddress: string,
  resource: Record<string, unknown>,
): AutomaticIsolationFinding[] {
  const findings: AutomaticIsolationFinding[] = [
    {
      code: "resource_review_required",
      filePath,
      resourceAddress,
      message:
        `Yaffle has not verified ${resourceAddress} for automatic preview isolation. ` +
        "Review is required before this transient workspace can plan.",
    },
  ]

  const lifecycleBlocks = Array.isArray(resource.lifecycle) ? resource.lifecycle : []
  if (
    lifecycleBlocks.some(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).prevent_destroy === true,
    )
  ) {
    findings.push({
      code: "prevent_destroy_not_allowed",
      filePath,
      resourceAddress,
      message:
        `${resourceAddress} sets lifecycle.prevent_destroy. Automatic preview resources must be destroyable; ` +
        "move shared resources to an upstream named, external, or static workspace.",
    })
  }

  if (resource.provisioner && typeof resource.provisioner === "object") {
    findings.push({
      code: "provisioner_not_allowed",
      filePath,
      resourceAddress,
      message:
        `${resourceAddress} declares a provisioner with side effects outside Terraform state. ` +
        "Provisioners are not supported in automatically isolated workspaces.",
    })
  }

  return findings
}

function inspectHclFile(file: AutomaticIsolationSourceFile): AutomaticIsolationFinding[] {
  if (file.path.endsWith(".tf.json")) {
    return [
      {
        code: "tf_json_not_supported",
        filePath: file.path,
        message: `${file.path} uses Terraform JSON syntax, which automatic preview isolation does not yet inspect.`,
      },
    ]
  }

  let document: ParsedHclDocument | null = null
  try {
    const parsed = hcl.parseToObject(file.content)
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed
    if (candidate && typeof candidate === "object") {
      document = candidate as ParsedHclDocument
    }
  } catch {
    document = null
  }

  if (!document) {
    return [
      {
        code: "hcl_parse_error",
        filePath: file.path,
        message: `Yaffle could not parse ${file.path}; automatic preview isolation fails closed.`,
      },
    ]
  }

  const findings: AutomaticIsolationFinding[] = []

  for (const importBlock of document.import ?? []) {
    const rawTarget = typeof importBlock.to === "string" ? importBlock.to : undefined
    const resourceAddress = rawTarget?.replace(/^\$\{/, "").replace(/\}$/, "")
    findings.push({
      code: "import_not_allowed",
      filePath: file.path,
      resourceAddress,
      message:
        `Import${resourceAddress ? ` for ${resourceAddress}` : ""} in ${file.path} can transfer shared resource ownership into transient state. ` +
        "Move imported resources to an upstream named, external, or static workspace.",
    })
  }

  for (const removedBlock of document.removed ?? []) {
    const rawTarget = typeof removedBlock.from === "string" ? removedBlock.from : undefined
    const resourceAddress = rawTarget?.replace(/^\$\{/, "").replace(/\}$/, "")
    findings.push({
      code: "removed_not_allowed",
      filePath: file.path,
      resourceAddress,
      message:
        `Removed block${resourceAddress ? ` for ${resourceAddress}` : ""} in ${file.path} can detach managed infrastructure from transient state. ` +
        "Removed blocks are not supported in automatically isolated workspaces.",
    })
  }

  for (const moduleName of Object.keys(document.module ?? {})) {
    findings.push({
      code: "module_review_required",
      filePath: file.path,
      resourceAddress: `module.${moduleName}`,
      message: `Yaffle must inspect the initialized resources under module.${moduleName} before automatic preview isolation can proceed.`,
    })
  }

  for (const [resourceType, resources] of Object.entries(document.resource ?? {})) {
    for (const [resourceName, instances] of Object.entries(resources)) {
      for (const resource of instances) {
        findings.push(...inspectResource(file.path, `${resourceType}.${resourceName}`, resource))
      }
    }
  }

  return findings
}

export function deriveAutomaticIsolationWorkspaceStatus(
  findings: AutomaticIsolationFinding[],
): AutomaticIsolationPreflightStatus {
  if (
    findings.some(
      (finding) =>
        finding.code !== "resource_review_required" && finding.code !== "module_review_required",
    )
  ) {
    return "blocked"
  }

  return findings.length > 0 ? "review_required" : "ready"
}

export function inspectAutomaticPreviewIsolationWorkspace(
  workspacePath: string,
  files: AutomaticIsolationSourceFile[],
): AutomaticIsolationWorkspacePreflight {
  const findings = files.flatMap(inspectHclFile)
  return {
    workspacePath,
    status: deriveAutomaticIsolationWorkspaceStatus(findings),
    findings,
  }
}

export function combineAutomaticIsolationPreflights(
  workspaces: AutomaticIsolationWorkspacePreflight[],
): AutomaticIsolationPreflight {
  const statuses = workspaces.map((workspace) =>
    deriveAutomaticIsolationWorkspaceStatus(workspace.findings),
  )
  const status = statuses.includes("blocked")
    ? "blocked"
    : statuses.includes("review_required")
      ? "review_required"
      : "ready"

  return { status, workspaces }
}
