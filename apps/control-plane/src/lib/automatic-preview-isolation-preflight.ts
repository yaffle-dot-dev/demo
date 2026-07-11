import {
  combineAutomaticIsolationPreflights,
  deriveAutomaticIsolationWorkspaceStatus,
  type AutomaticIsolationPreflight,
} from "@yaffle/shared"

export interface AutomaticIsolationPreflightOutcome {
  runGroupStatus: "isolation_review_required" | "isolation_blocked"
  conclusion: "action_required" | "failure"
  title: string
  summary: string
}

export function validateAutomaticIsolationPreflightCoverage(
  expectedWorkspacePaths: string[],
  preflight: AutomaticIsolationPreflight | undefined,
): string | null {
  const expected = [...new Set(expectedWorkspacePaths)].sort()
  const actual = [
    ...new Set(preflight?.workspaces.map((workspace) => workspace.workspacePath) ?? []),
  ].sort()

  if (expected.join("\0") !== actual.join("\0")) {
    return `automatic isolation preflight coverage mismatch: expected [${expected.join(", ")}], received [${actual.join(", ")}]`
  }

  if (!preflight) {
    return null
  }

  for (const workspace of preflight.workspaces) {
    const derivedStatus = deriveAutomaticIsolationWorkspaceStatus(workspace.findings)
    if (derivedStatus !== workspace.status) {
      return `automatic isolation workspace status mismatch for ${workspace.workspacePath}: expected ${derivedStatus}, received ${workspace.status}`
    }
  }

  const combined = combineAutomaticIsolationPreflights(preflight.workspaces)
  if (combined.status !== preflight.status) {
    return `automatic isolation preflight status mismatch: expected ${combined.status}, received ${preflight.status}`
  }

  return null
}

export function getAutomaticIsolationPreflightOutcome(
  preflight: AutomaticIsolationPreflight | undefined,
): AutomaticIsolationPreflightOutcome | null {
  if (!preflight || preflight.status === "ready") {
    return null
  }

  const findingLines = preflight.workspaces.flatMap((workspace) =>
    workspace.findings.map((finding) => {
      const address = finding.resourceAddress ? ` ${finding.resourceAddress}` : ""
      return `- \`${workspace.workspacePath}\`${address}: ${finding.message}`
    }),
  )
  const displayedFindings = findingLines.slice(0, 20)
  const hiddenCount = findingLines.length - displayedFindings.length
  if (hiddenCount > 0) {
    displayedFindings.push(`- ${hiddenCount} additional finding(s) are available in Yaffle Cloud.`)
  }

  const guidance =
    "Shared or non-preview resources must live in an upstream named, external, or static workspace " +
    "and be consumed through authorized outputs or read-only data sources. No Terraform plan was created."
  const summary = [
    preflight.status === "blocked"
      ? "Automatic preview isolation found unsupported ownership or lifecycle constructs."
      : "Yaffle has not yet verified every managed resource for automatic preview isolation.",
    "",
    ...displayedFindings,
    "",
    guidance,
  ].join("\n")

  return preflight.status === "blocked"
    ? {
        runGroupStatus: "isolation_blocked",
        conclusion: "failure",
        title: "Automatic preview isolation blocked",
        summary,
      }
    : {
        runGroupStatus: "isolation_review_required",
        conclusion: "action_required",
        title: "Automatic preview isolation review required",
        summary,
      }
}
