import { db } from "../lib/db.ts"
import { listConnectionsForOrg } from "../db/queries/connections.ts"
import { updateOrg } from "../db/queries/organizations.ts"
import { organizations } from "../db/schema.ts"
import {
  ensureOrgBrokerRole,
  syncOrgKmsKeyPolicy,
  syncOrgBrokerRoleAssumeTargets,
} from "../lib/org-provisioning.ts"

function listIamRoleTargets(
  connections: Array<{ credentialProviderType: string | null; config: unknown }>,
): string[] {
  const targets = new Set<string>()

  for (const connection of connections) {
    if (connection.credentialProviderType !== "iam_role") {
      continue
    }

    const config =
      typeof connection.config === "object" && connection.config !== null
        ? (connection.config as Record<string, unknown>)
        : {}

    const roleArn = typeof config.roleArn === "string" ? config.roleArn : null
    if (roleArn) {
      targets.add(roleArn)
    }
  }

  return [...targets].sort()
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")

  const allOrgs = await db.select().from(organizations)
  const candidateOrgs = allOrgs.filter((org) => org.provisioningStatus !== "pending")

  console.info(
    `Found ${candidateOrgs.length} organizations to inspect (${apply ? "apply" : "dry-run"} mode)`,
  )

  for (const org of candidateOrgs) {
    const connections = await listConnectionsForOrg(org.id)
    const iamTargets = listIamRoleTargets(connections)

    if (!apply) {
      console.info(
        `[dry-run] org=${org.slug} currentRole=${org.iamRoleArn ?? "<none>"} ` +
          `kms=${org.kmsKeyArn ?? "<none>"} targets=${iamTargets.length}`,
      )
      continue
    }

    if (!org.kmsKeyArn) {
      console.warn(`skipping org ${org.slug}: missing kms_key_arn`)
      continue
    }

    const brokerRoleArn = await ensureOrgBrokerRole(org.id)

    if (org.iamRoleArn !== brokerRoleArn) {
      await updateOrg(org.id, { iamRoleArn: brokerRoleArn })
      console.info(`updated org ${org.slug} iamRoleArn -> ${brokerRoleArn}`)
    }

    await syncOrgKmsKeyPolicy(org.id, org.kmsKeyArn, brokerRoleArn)
    await syncOrgBrokerRoleAssumeTargets(org.id, org.slug, brokerRoleArn, org.kmsKeyArn, iamTargets)
    console.info(
      `synced broker targets for org ${org.slug} (${iamTargets.length} role ARN${iamTargets.length === 1 ? "" : "s"})`,
    )
  }

  console.info(`org broker role migration complete (${apply ? "apply" : "dry-run"})`)
}

main().catch((error) => {
  console.error("org broker role migration failed", error)
  process.exit(1)
})
