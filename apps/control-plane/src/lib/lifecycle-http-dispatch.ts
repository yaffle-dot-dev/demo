import { lookup } from "node:dns/promises"
import { request as httpsRequest, type RequestOptions } from "node:https"
import { isIP } from "node:net"

export interface LifecycleDestinationAddress {
  address: string
  family: 4 | 6
}

type LookupLifecycleAddresses = (hostname: string) => Promise<LifecycleDestinationAddress[]>

interface LifecycleRequest {
  setTimeout(timeoutMs: number, callback: () => void): void
  on(event: "error", callback: (error: Error) => void): void
  end(body: Buffer): void
  destroy(error: Error): void
}

interface LifecycleResponse {
  statusCode?: number
  resume(): void
}

export type LifecycleRequestAdapter = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: LifecycleResponse) => void,
) => LifecycleRequest

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const

function ipv4ToNumber(address: string): number | null {
  const octets = address.split(".").map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null
  }
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0
}

function ipv4InCidr(address: number, network: string, prefix: number): boolean {
  const networkNumber = ipv4ToNumber(network)
  if (networkNumber === null) {
    return false
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) >>> 0 === (networkNumber & mask) >>> 0
}

export function isPublicLifecycleAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized.startsWith("::ffff:")) {
    return isPublicLifecycleAddress(normalized.slice(7))
  }

  if (isIP(normalized) === 4) {
    const value = ipv4ToNumber(normalized)
    return (
      value !== null &&
      !BLOCKED_IPV4_CIDRS.some(([network, prefix]) => ipv4InCidr(value, network, prefix))
    )
  }

  if (isIP(normalized) !== 6) {
    return false
  }

  if (!/^[23]/.test(normalized)) {
    return false
  }
  if (normalized.startsWith("2002:")) {
    return false
  }
  if (!normalized.startsWith("2001:")) {
    return true
  }

  const secondHextet = Number.parseInt(normalized.split(":")[1] || "0", 16)
  return !(
    secondHextet <= 4 ||
    (secondHextet >= 0x10 && secondHextet <= 0x2f) ||
    secondHextet === 0xdb8
  )
}

async function lookupLifecycleAddresses(hostname: string): Promise<LifecycleDestinationAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
}

export async function resolvePublicLifecycleDestination(
  rawUrl: string,
  lookupAddresses: LookupLifecycleAddresses = lookupLifecycleAddresses,
): Promise<LifecycleDestinationAddress> {
  const url = new URL(rawUrl)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Lifecycle webhooks must use an unauthenticated public HTTPS URL without query or fragment",
    )
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const family = isIP(hostname)
  const addresses = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : await lookupAddresses(hostname)
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicLifecycleAddress(address))
  ) {
    throw new Error("Lifecycle webhook destinations must resolve only to public IP addresses")
  }
  return addresses[0]
}

export async function postPublicLifecycleWebhook(values: {
  url: string
  headers: Headers
  body: Buffer
  destination?: LifecycleDestinationAddress
  timeoutMs?: number
  request?: LifecycleRequestAdapter
}): Promise<number> {
  const destination = values.destination ?? (await resolvePublicLifecycleDestination(values.url))
  const url = new URL(values.url)

  return new Promise((resolve, reject) => {
    const request = (values.request ?? httpsRequest)(
      url,
      {
        method: "POST",
        headers: Object.fromEntries(values.headers.entries()),
        servername: url.hostname,
        lookup: (_hostname, _options, callback) =>
          callback(null, destination.address, destination.family),
      },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 502)
      },
    )
    request.setTimeout(values.timeoutMs ?? 30_000, () =>
      request.destroy(new Error("Lifecycle webhook timed out")),
    )
    request.on("error", reject)
    request.end(values.body)
  })
}
