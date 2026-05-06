import { createHash } from "node:crypto"

import { findRunGroupById } from "../db/queries/run-groups.ts"
import { findRepoByName } from "../db/queries/repositories.ts"
import { findPrincipalRepoBindingById, publishHostedOutputModule } from "../db/queries/principals.ts"

export async function publishHostedOutputModuleForRunGroupBinding(values: {
  runGroupId?: string | null
  environmentName: string
  workspacePath: string
  outputs?: Record<string, unknown> | null
}): Promise<string | null> {
  if (!values.runGroupId || !values.outputs) {
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

  const binding = runGroup.repoBindingId
    ? await findPrincipalRepoBindingById(runGroup.repoBindingId)
    : undefined
  if (runGroup.repoBindingId && !binding) {
    throw new Error(`run group ${values.runGroupId} is missing its principal repo binding`)
  }

  const stateFingerprint = createHash("sha256")
    .update(JSON.stringify(values.outputs))
    .digest("hex")

  const published = await publishHostedOutputModule({
    principalId: binding?.principalId,
    repoBindingId: binding?.id,
    canonicalRepoNamespace,
    environmentName: values.environmentName,
    workspacePath: values.workspacePath,
    stateFingerprint,
    outputs: values.outputs,
  })

  return `1.0.${published.versionSerial}`
}
