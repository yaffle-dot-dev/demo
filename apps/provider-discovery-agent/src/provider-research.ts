import type {
  DiscoverySource,
  ProviderCandidate,
  ProviderDetails,
  ProviderDiscoveryRunResult,
  ProviderRegistryDoc,
} from "./types"

const TERRAFORM_REGISTRY_BASE_URL = "https://registry.terraform.io"
const GITHUB_API_BASE_URL = "https://api.github.com"
const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com"

const MAX_FETCH_BYTES = 1_000_000

const AUTH_HINT_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|USERNAME|EMAIL|URL|HOST|REGION|ACCOUNT|CLIENT|TENANT|PROJECT|ORG|ID|PRIVATE|PUBLIC|ACCESS|API)/
const ENV_VAR_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\b/g

const SKIP_ENV_VARS = new Set([
  "AWS_REGION",
  "CI",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "PATH",
  "PWD",
  "SHELL",
  "TF_CLI_ARGS",
  "TF_DATA_DIR",
  "TF_IN_AUTOMATION",
  "TF_LOG",
  "TF_LOG_PATH",
])

function normalizeProviderType(providerType: string): string {
  return providerType.trim().toLowerCase()
}

function normalizeProviderToken(providerType: string): string {
  return providerType.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function normalizeEnvVarToken(token: string): string {
  return token.toUpperCase().replace(/[^A-Z0-9_]/g, "")
}

function sanitizeAgentName(providerType: string): string {
  return providerType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function hasCredentialHint(token: string): boolean {
  return AUTH_HINT_PATTERN.test(token)
}

function shouldIgnoreEnvVar(token: string): boolean {
  if (SKIP_ENV_VARS.has(token)) {
    return true
  }

  if (token.startsWith("TF_")) {
    return true
  }

  if (token.startsWith("TERRAFORM_")) {
    return true
  }

  return false
}

function scoreToken(params: {
  providerType: string
  token: string
  line: string
}): number {
  const providerType = normalizeProviderType(params.providerType)
  const providerNormalized = normalizeProviderToken(providerType)
  const providerPrefix = providerType
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const tokenNormalized = params.token.replace(/_/g, "")

  let score = 0

  if (tokenNormalized.includes(providerNormalized)) {
    score += 3
  }

  if (providerPrefix && params.token.startsWith(`${providerPrefix}_`)) {
    score += 2
  }

  if (params.line.toLowerCase().includes(providerType)) {
    score += 2
  }

  if (hasCredentialHint(params.token)) {
    score += 1
  }

  return score
}

function parseGitHubRepo(sourceUrl: string | undefined): { owner: string; repo: string } | null {
  if (!sourceUrl) {
    return null
  }

  const match = sourceUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (!match) {
    return null
  }

  return {
    owner: match[1],
    repo: match[2],
  }
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const response = await fetchWithTimeout(url, init, timeoutMs)
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`)
  }

  return response.json() as Promise<T>
}

async function fetchText(url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const response = await fetchWithTimeout(url, init, timeoutMs)
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`)
  }

  const text = await response.text()
  return text.slice(0, MAX_FETCH_BYTES)
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

function rankProviderCandidate(a: ProviderCandidate, b: ProviderCandidate): number {
  const scoreTier = (tier: string | undefined): number => {
    if (tier === "official") return 3
    if (tier === "partner") return 2
    return 1
  }

  return scoreTier(b.tier) - scoreTier(a.tier) || (b.downloads ?? 0) - (a.downloads ?? 0)
}

async function resolveProviderCandidate(
  providerType: string,
  timeoutMs: number,
): Promise<ProviderCandidate | null> {
  const normalized = normalizeProviderType(providerType)

  const sourceMatch = normalized.match(/^([^/]+)\/([^/]+)$/)
  if (sourceMatch) {
    return {
      namespace: sourceMatch[1],
      name: sourceMatch[2],
    }
  }

  const url = `${TERRAFORM_REGISTRY_BASE_URL}/v1/providers?name=${encodeURIComponent(normalized)}`
  type ProviderSearchResponse = {
    providers?: ProviderCandidate[]
  }

  const payload = await fetchJson<ProviderSearchResponse>(url, {
    headers: {
      "content-type": "application/json",
      "user-agent": "yaffle-provider-discovery-agent",
    },
  }, timeoutMs)

  const exactMatches = (payload.providers ?? [])
    .filter((candidate) => candidate.name.toLowerCase() === normalized)
    .sort(rankProviderCandidate)

  return exactMatches[0] ?? null
}

async function fetchProviderDetails(
  candidate: ProviderCandidate,
  timeoutMs: number,
): Promise<ProviderDetails> {
  type ProviderDetailResponse = {
    namespace: string
    name: string
    description?: string
    source?: string
    tier?: string
    docs?: Array<{
      title: string
      path: string
      slug: string
      category: string
    }>
  }

  const url = `${TERRAFORM_REGISTRY_BASE_URL}/v1/providers/${candidate.namespace}/${candidate.name}`
  const payload = await fetchJson<ProviderDetailResponse>(url, {
    headers: {
      "content-type": "application/json",
      "user-agent": "yaffle-provider-discovery-agent",
    },
  }, timeoutMs)

  return {
    namespace: payload.namespace,
    name: payload.name,
    description: payload.description,
    source: payload.source,
    tier: payload.tier,
    docs: (payload.docs ?? []).map((doc) => ({
      title: doc.title,
      path: doc.path,
      slug: doc.slug,
      category: doc.category,
    })),
  }
}

async function fetchGitHubDefaultBranch(params: {
  owner: string
  repo: string
  timeoutMs: number
  githubToken?: string
}): Promise<string> {
  type GitHubRepoResponse = {
    default_branch?: string
  }

  const headers: HeadersInit = {
    accept: "application/vnd.github+json",
    "user-agent": "yaffle-provider-discovery-agent",
  }

  if (params.githubToken) {
    headers.authorization = `Bearer ${params.githubToken}`
  }

  const payload = await fetchJson<GitHubRepoResponse>(
    `${GITHUB_API_BASE_URL}/repos/${params.owner}/${params.repo}`,
    { headers },
    params.timeoutMs,
  )

  return payload.default_branch ?? "main"
}

function pickHighSignalDocs(docs: ProviderRegistryDoc[], maxDocs: number): ProviderRegistryDoc[] {
  const ranked = [...docs].sort((a, b) => {
    const score = (doc: ProviderRegistryDoc): number => {
      if (doc.slug === "index") return 100
      if (doc.category === "overview") return 90
      if (doc.category === "guides") return 80

      const hint = `${doc.title} ${doc.slug} ${doc.path}`.toLowerCase()
      if (/(provider|configuration|auth|authentication|credentials)/.test(hint)) return 70
      return 10
    }

    return score(b) - score(a)
  })

  const deduped = new Map<string, ProviderRegistryDoc>()
  for (const doc of ranked) {
    if (!doc.path.endsWith(".md")) {
      continue
    }

    if (!deduped.has(doc.path)) {
      deduped.set(doc.path, doc)
    }

    if (deduped.size >= maxDocs) {
      break
    }
  }

  return [...deduped.values()]
}

export function extractCandidateEnvVarsFromText(params: {
  text: string
  providerType: string
}): Map<string, number> {
  const out = new Map<string, number>()
  const lines = params.text.split(/\r?\n/)

  for (const line of lines) {
    ENV_VAR_PATTERN.lastIndex = 0
    const matches = line.match(ENV_VAR_PATTERN)
    if (!matches) {
      continue
    }

    for (const rawToken of matches) {
      const token = normalizeEnvVarToken(rawToken)
      if (!token || shouldIgnoreEnvVar(token) || !hasCredentialHint(token)) {
        continue
      }

      const score = scoreToken({
        providerType: params.providerType,
        token,
        line,
      })

      if (score < 3) {
        continue
      }

      const existing = out.get(token) ?? 0
      out.set(token, Math.max(existing, score))
    }
  }

  return out
}

export function inferPrefixEnvVars(params: {
  providerType: string
  exactEnvVars: string[]
}): string[] {
  const target = normalizeProviderToken(params.providerType)
  const prefixCounts = new Map<string, number>()

  const guessed = params.providerType
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (guessed) {
    const guessedPrefix = `${guessed}_`
    if (params.exactEnvVars.some((key) => key.startsWith(guessedPrefix))) {
      prefixCounts.set(guessedPrefix, 2)
    }
  }

  for (const key of params.exactEnvVars) {
    const segments = key.split("_")
    if (segments.length < 2) {
      continue
    }

    for (let index = 1; index <= Math.min(3, segments.length - 1); index += 1) {
      const prefix = `${segments.slice(0, index).join("_")}_`
      const normalizedPrefix = prefix.replace(/_/g, "")
      const minimumLength = Math.max(4, Math.floor(target.length * 0.6))

      if (normalizedPrefix.length < minimumLength) {
        continue
      }

      if (!normalizedPrefix.includes(target) && !target.includes(normalizedPrefix)) {
        continue
      }

      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
    }
  }

  return [...prefixCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix]) => prefix)
    .slice(0, 3)
}

async function collectGitHubMarkdown(params: {
  owner: string
  repo: string
  defaultBranch: string
  docs: ProviderRegistryDoc[]
  timeoutMs: number
}): Promise<Array<{ url: string; text: string }>> {
  const documents: Array<{ url: string; text: string }> = []
  const paths = new Set<string>([
    "README.md",
    ...params.docs.map((doc) => doc.path),
  ])

  for (const path of paths) {
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")
    const url = `${GITHUB_RAW_BASE_URL}/${params.owner}/${params.repo}/${params.defaultBranch}/${encodedPath}`

    try {
      const text = await fetchText(url, {
        headers: {
          "user-agent": "yaffle-provider-discovery-agent",
        },
      }, params.timeoutMs)

      documents.push({ url, text })
    } catch {
      continue
    }
  }

  return documents
}

export async function discoverProviderCredentials(params: {
  providerType: string
  timeoutMs: number
  maxDocs: number
  githubToken?: string
}): Promise<ProviderDiscoveryRunResult> {
  const normalizedProviderType = sanitizeAgentName(params.providerType)
  if (!normalizedProviderType) {
    return {
      status: "failed",
      confidence: "low",
      exactEnvVars: [],
      prefixEnvVars: [],
      sources: [],
      reasoningSummary: "Provider type was empty after normalization",
    }
  }

  const sources: DiscoverySource[] = []
  const aggregate = new Map<string, { score: number; occurrences: number }>()

  const candidate = await resolveProviderCandidate(normalizedProviderType, params.timeoutMs)
  if (!candidate) {
    return {
      status: "inconclusive",
      confidence: "low",
      displayName: normalizedProviderType,
      exactEnvVars: [],
      prefixEnvVars: [],
      sources,
      reasoningSummary: "No exact provider match found in Terraform Registry",
    }
  }

  const details = await fetchProviderDetails(candidate, params.timeoutMs)
  sources.push({
    kind: "terraform_registry",
    url: `${TERRAFORM_REGISTRY_BASE_URL}/providers/${details.namespace}/${details.name}/latest/docs`,
  })

  const repo = parseGitHubRepo(details.source)
  if (repo) {
    const defaultBranch = await fetchGitHubDefaultBranch({
      owner: repo.owner,
      repo: repo.repo,
      timeoutMs: params.timeoutMs,
      githubToken: params.githubToken,
    })

    const docs = pickHighSignalDocs(details.docs, params.maxDocs)
    const documents = await collectGitHubMarkdown({
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch,
      docs,
      timeoutMs: params.timeoutMs,
    })

    for (const document of documents) {
      const extracted = extractCandidateEnvVarsFromText({
        text: document.text,
        providerType: normalizedProviderType,
      })

      for (const [token, score] of extracted.entries()) {
        const current = aggregate.get(token)
        if (current) {
          current.score = Math.max(current.score, score)
          current.occurrences += 1
        } else {
          aggregate.set(token, { score, occurrences: 1 })
        }
      }

      sources.push({
        kind: "github_repository_docs",
        url: document.url,
      })
    }
  }

  const exactEnvVars = [...aggregate.entries()]
    .filter(([, value]) => value.score >= 3)
    .sort((a, b) => b[1].score - a[1].score || b[1].occurrences - a[1].occurrences)
    .map(([token]) => token)
    .slice(0, 25)

  const prefixEnvVars = inferPrefixEnvVars({
    providerType: normalizedProviderType,
    exactEnvVars,
  })

  const hasOfficialEvidence = sources.some((source) =>
    source.kind === "terraform_registry" || source.kind === "github_repository_docs"
  )

  const confidence = exactEnvVars.length >= 2 && prefixEnvVars.length > 0 && hasOfficialEvidence
    ? "high"
    : exactEnvVars.length >= 1 && hasOfficialEvidence
      ? "medium"
      : "low"

  const status = exactEnvVars.length > 0 ? "succeeded" : "inconclusive"

  return {
    status,
    confidence,
    displayName: details.name,
    exactEnvVars,
    prefixEnvVars,
    sources: dedupeSources(sources),
    reasoningSummary: buildReasoningSummary({
      provider: `${details.namespace}/${details.name}`,
      exactCount: exactEnvVars.length,
      prefixCount: prefixEnvVars.length,
      confidence,
    }),
  }
}

function dedupeSources(sources: DiscoverySource[]): DiscoverySource[] {
  const deduped = new Map<string, DiscoverySource>()
  for (const source of sources) {
    const key = `${source.kind}:${source.url}`
    if (!deduped.has(key)) {
      deduped.set(key, source)
    }
  }

  return [...deduped.values()].slice(0, 20)
}

function buildReasoningSummary(params: {
  provider: string
  exactCount: number
  prefixCount: number
  confidence: "high" | "medium" | "low"
}): string {
  return [
    `Analyzed Terraform provider ${params.provider}.`,
    `Found ${params.exactCount} exact environment variables.`,
    `Derived ${params.prefixCount} provider prefixes.`,
    `Assigned ${params.confidence} confidence from source quality and signal strength.`,
  ].join(" ")
}
