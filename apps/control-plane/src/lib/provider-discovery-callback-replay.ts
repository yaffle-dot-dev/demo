const NONCE_TTL_MS = 5 * 60 * 1000
const MAX_NONCE_ENTRIES = 10_000

const usedNonces = new Map<string, number>()

function pruneExpiredNonces(now: number): void {
  for (const [nonce, expiresAt] of usedNonces.entries()) {
    if (expiresAt <= now) {
      usedNonces.delete(nonce)
    }
  }
}

function trimNonceCache(): void {
  if (usedNonces.size <= MAX_NONCE_ENTRIES) {
    return
  }

  const overflow = usedNonces.size - MAX_NONCE_ENTRIES
  let removed = 0
  for (const nonce of usedNonces.keys()) {
    usedNonces.delete(nonce)
    removed += 1
    if (removed >= overflow) {
      break
    }
  }
}

export function consumeProviderDiscoveryCallbackNonce(
  nonce: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!nonce) {
    return false
  }

  const normalized = nonce.trim()
  if (!normalized) {
    return false
  }

  pruneExpiredNonces(now)

  const existing = usedNonces.get(normalized)
  if (existing && existing > now) {
    return false
  }

  usedNonces.set(normalized, now + NONCE_TTL_MS)
  trimNonceCache()
  return true
}

export function clearProviderDiscoveryCallbackNonceCacheForTests(): void {
  usedNonces.clear()
}
