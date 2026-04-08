function parseCredentialHosts(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }

  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.startsWith("."))
    .filter((entry) => !entry.includes("://"))
    .filter((entry) => !entry.includes("/"))
}

export function buildTfcCredentialHosts(primaryHost: string): string[] {
  const hosts = [primaryHost.trim(), ...parseCredentialHosts(process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS)]

  return [...new Set(hosts.filter((host) => host.length > 0))]
}
