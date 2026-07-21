import { and, asc, eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { withDbSpan } from "../../lib/telemetry.ts"
import { providerCredentialSignatures } from "../schema.ts"
import {
  DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES,
  type ProviderCredentialSignatureSeed,
} from "../../lib/default-provider-credential-signatures.ts"

export type ProviderCredentialSignature = typeof providerCredentialSignatures.$inferSelect

export interface UpsertDiscoveredProviderCredentialSignatureInput {
  providerType: string
  displayName: string
  suggestedCredentialProviderType: "envvar" | "iam_role"
  exactEnvVars: string[]
  prefixEnvVars: string[]
  isActive: boolean
  source: string
}

async function seedProviderCredentialSignature(
  seed: ProviderCredentialSignatureSeed,
): Promise<void> {
  await db
    .insert(providerCredentialSignatures)
    .values({
      providerType: seed.providerType,
      displayName: seed.displayName,
      suggestedCredentialProviderType: seed.suggestedCredentialProviderType,
      exactEnvVars: seed.exactEnvVars,
      prefixEnvVars: seed.prefixEnvVars,
      source: "system",
      isActive: true,
    })
    .onConflictDoNothing({
      target: providerCredentialSignatures.providerType,
    })
}

/**
 * Seed default provider signatures if they do not exist.
 * Existing rows are intentionally preserved to support runtime edits.
 */
export async function ensureDefaultProviderCredentialSignatures(): Promise<void> {
  await withDbSpan("upsert", "provider_credential_signatures", async () => {
    for (const seed of DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES) {
      await seedProviderCredentialSignature(seed)
    }
  })
}

export async function listActiveProviderCredentialSignatures(): Promise<
  ProviderCredentialSignature[]
> {
  return withDbSpan("select", "provider_credential_signatures", async () => {
    return db
      .select()
      .from(providerCredentialSignatures)
      .where(and(eq(providerCredentialSignatures.isActive, true)))
      .orderBy(
        asc(providerCredentialSignatures.displayName),
        asc(providerCredentialSignatures.providerType),
      )
  })
}

export async function findProviderCredentialSignatureByType(
  providerType: string,
): Promise<ProviderCredentialSignature | undefined> {
  const normalized = providerType.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  return withDbSpan("select", "provider_credential_signatures", async () => {
    const rows = await db
      .select()
      .from(providerCredentialSignatures)
      .where(eq(providerCredentialSignatures.providerType, normalized))
      .limit(1)

    return rows[0]
  })
}

export async function upsertDiscoveredProviderCredentialSignature(
  input: UpsertDiscoveredProviderCredentialSignatureInput,
): Promise<ProviderCredentialSignature> {
  const normalizedProviderType = input.providerType.trim().toLowerCase()

  return withDbSpan("upsert", "provider_credential_signatures", async () => {
    const rows = await db
      .insert(providerCredentialSignatures)
      .values({
        providerType: normalizedProviderType,
        displayName: input.displayName,
        suggestedCredentialProviderType: input.suggestedCredentialProviderType,
        exactEnvVars: input.exactEnvVars,
        prefixEnvVars: input.prefixEnvVars,
        isActive: input.isActive,
        source: input.source,
      })
      .onConflictDoUpdate({
        target: providerCredentialSignatures.providerType,
        set: {
          displayName: input.displayName,
          suggestedCredentialProviderType: input.suggestedCredentialProviderType,
          exactEnvVars: input.exactEnvVars,
          prefixEnvVars: input.prefixEnvVars,
          isActive: input.isActive,
          source: input.source,
          updatedAt: new Date(),
        },
      })
      .returning()

    return rows[0]
  })
}
