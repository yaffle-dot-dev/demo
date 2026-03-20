import {
  listActiveProviderCredentialSignatures,
  type ProviderCredentialSignature,
} from "../db/queries/provider-credential-signatures.ts"

export interface InferProviderTypeOptions {
  signatures: Array<Pick<ProviderCredentialSignature,
    | "providerType"
    | "exactEnvVars"
    | "prefixEnvVars"
  >>
}

export function inferProviderTypeFromEnvVarKeysWithSignatures(
  envVarKeys: string[],
  options: InferProviderTypeOptions,
): string {
  if (envVarKeys.length === 0) {
    return "generic"
  }

  const normalizedKeys = envVarKeys
    .map((key) => key.trim().toUpperCase())
    .filter((key) => key.length > 0)

  if (normalizedKeys.length === 0) {
    return "generic"
  }

  let bestProvider = "generic"
  let bestScore = 0
  let isTie = false

  for (const signature of options.signatures) {
    const exactSet = new Set(signature.exactEnvVars.map((key) => key.toUpperCase()))
    const prefixes = (signature.prefixEnvVars ?? []).map((prefix) => prefix.toUpperCase())

    let score = 0
    for (const key of normalizedKeys) {
      if (exactSet.has(key)) {
        score += 2
        continue
      }

      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        score += 1
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestProvider = signature.providerType
      isTie = false
      continue
    }

    if (score > 0 && score === bestScore) {
      isTie = true
    }
  }

  if (bestScore === 0 || isTie) {
    return "generic"
  }

  return bestProvider
}

export async function inferProviderTypeFromEnvVarKeys(envVarKeys: string[]): Promise<string> {
  const signatures = await listActiveProviderCredentialSignatures()

  return inferProviderTypeFromEnvVarKeysWithSignatures(envVarKeys, {
    signatures,
  })
}
