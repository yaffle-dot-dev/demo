import { createHash } from "node:crypto"

import { findRunGroupById } from "../db/queries/run-groups.ts"
import { findRepoByName } from "../db/queries/repositories.ts"
import {
  findPrincipalRepoBindingById,
  publishHostedOutputModule,
} from "../db/queries/principals.ts"
import { deploymentBelongsToRunGroup } from "../db/queries/workspace-deployments.ts"
import {
  findExecutionSnapshotWorkspace,
  isExecutionContextAssociationValid,
} from "./execution-snapshot.ts"
import { selectTerraformOutputs } from "./output-selection.ts"

export async function publishHostedOutputModuleForRunGroupBinding(values: {
  runGroupId?: string | null
  deploymentId?: string
  environmentName: string
  workspacePath: string
  outputs?: Record<string, unknown> | null
}): Promise<string | null> {
  if (!values.runGroupId || !values.outputs) {
    return null
  }
  if (
    values.deploymentId &&
    !(await deploymentBelongsToRunGroup(values.deploymentId, values.runGroupId))
  ) {
    return null
  }

  const runGroup = await findRunGroupById(values.runGroupId)
  if (!runGroup) {
    return null
  }

  const repository = await findRepoByName(runGroup.orgId, runGroup.repo)
  if (!repository?.fullName) {
    throw new Error(`run group ${values.runGroupId} is missing its canonical repository mapping`)
  }
  const canonicalRepoNamespace = repository.fullName.replace("/", "--")

  if (!runGroup.repoBindingId || !runGroup.executionSnapshot) {
    return null
  }
  const binding = await findPrincipalRepoBindingById(runGroup.repoBindingId)
  const workspace = findExecutionSnapshotWorkspace(runGroup.executionSnapshot, values.workspacePath)
  if (
    !binding ||
    !workspace ||
    canonicalRepoNamespace !== binding.canonicalRepoNamespace ||
    !isExecutionContextAssociationValid({
      snapshot: runGroup.executionSnapshot,
      runGroup,
      resource: {
        orgId: runGroup.orgId,
        repo: runGroup.repo,
        environmentKind: runGroup.environmentKind,
        environmentName: values.environmentName,
        workspacePath: values.workspacePath,
      },
      canonicalRepoNamespace: binding.canonicalRepoNamespace,
      requireRepoBinding: true,
    })
  ) {
    return null
  }

  const selectedOutputs =
    selectTerraformOutputs({
      outputs: values.outputs,
      selection: { kind: "policy", policies: workspace.outputs },
      sensitive: "reject",
    }) ?? {}

  const stateFingerprint = createHash("sha256")
    .update(JSON.stringify(selectedOutputs))
    .digest("hex")

  const published = await publishHostedOutputModule({
    principalId: binding.principalId,
    repoBindingId: binding.id,
    canonicalRepoNamespace,
    environmentName: values.environmentName,
    workspacePath: values.workspacePath,
    stateFingerprint,
    outputs: selectedOutputs,
  })

  return `1.0.${published.versionSerial}`
}
