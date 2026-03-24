import type {
  DiscoverySource,
  ProviderCandidate,
  ProviderCredentialExtractionResult,
  ProviderDetails,
  ProviderDocument,
  ProviderDiscoveryRunResult,
  ProviderResearchMaterial,
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

async function fetchGitHubTreePaths(params: {
  owner: string
  repo: string
  defaultBranch: string
  timeoutMs: number
  githubToken?: string
}): Promise<string[]> {
  type GitHubTreeResponse = {
    tree?: Array<{
      path?: string
      type?: string
    }>
  }

  const headers: HeadersInit = {
    accept: "application/vnd.github+json",
    "user-agent": "yaffle-provider-discovery-agent",
  }

  if (params.githubToken) {
    headers.authorization = `Bearer ${params.githubToken}`
  }

  const payload = await fetchJson<GitHubTreeResponse>(
    `${GITHUB_API_BASE_URL}/repos/${params.owner}/${params.repo}/git/trees/${params.defaultBranch}?recursive=1`,
    { headers },
    params.timeoutMs,
  )

  return (payload.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path as string)
}

function pickHighSignalDocs(docs: ProviderRegistryDoc[], maxDocs: number): ProviderRegistryDoc[] {
  const ranked = [...docs].sort((a, b) => {
    const score = (doc: ProviderRegistryDoc): number => {
      if (/website\/docs\/index\.html\.markdown$/i.test(doc.path)) return 110
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
    if (!/\.(md|markdown|mdx)$/i.test(doc.path)) {
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

function pickFallbackMarkdownPaths(paths: string[], maxDocs: number): string[] {
  const ranked = [...new Set(paths)]
    .filter((path) => /\.(md|markdown|mdx)$/i.test(path))
    .sort((a, b) => scoreFallbackPath(b) - scoreFallbackPath(a) || a.localeCompare(b))

  return ranked.slice(0, maxDocs)
}

function scoreFallbackPath(path: string): number {
  const normalized = path.toLowerCase()

  if (/^website\/docs\/index\.html\.markdown$/.test(normalized)) return 120
  if (/^readme\.md$/.test(normalized)) return 100
  if (/(provider|configuration|config|auth|authentication|credential)/.test(normalized)) return 90
  if (/website\/docs\//.test(normalized)) return 80
  if (/docs\//.test(normalized)) return 70
  return 10
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
  paths: string[]
  timeoutMs: number
}): Promise<ProviderDocument[]> {
  const documents: ProviderDocument[] = []
  const paths = new Set<string>(params.paths)

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

        documents.push({
          url,
          text,
          kind: "github_repository_docs",
        })
    } catch {
      continue
    }
  }

  return documents
}

async function collectProviderResearchMaterial(params: {
  providerType: string
  timeoutMs: number
  maxDocs: number
  githubToken?: string
}): Promise<ProviderResearchMaterial | null> {
  const requestedProviderType = normalizeProviderType(params.providerType)
  const candidate = await resolveProviderCandidate(requestedProviderType, params.timeoutMs)
  if (!candidate) {
    return null
  }

  const details = await fetchProviderDetails(candidate, params.timeoutMs)
  const sources: DiscoverySource[] = [
    {
      kind: "terraform_registry",
      url: `${TERRAFORM_REGISTRY_BASE_URL}/providers/${details.namespace}/${details.name}/latest/docs`,
    },
  ]
  const documents: ProviderDocument[] = []

  const repo = parseGitHubRepo(details.source)
  if (repo) {
    const defaultBranch = await fetchGitHubDefaultBranch({
      owner: repo.owner,
      repo: repo.repo,
      timeoutMs: params.timeoutMs,
      githubToken: params.githubToken,
    })

    const docs = pickHighSignalDocs(details.docs, params.maxDocs)
    const primaryPaths = [
      "README.md",
      ...docs.map((doc) => doc.path),
    ]

    const primaryDocuments = await collectGitHubMarkdown({
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch,
      paths: primaryPaths,
      timeoutMs: params.timeoutMs,
    })

    for (const document of primaryDocuments) {
      documents.push(document)
      sources.push({ kind: document.kind, url: document.url })
    }

    const treePaths = await fetchGitHubTreePaths({
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch,
      timeoutMs: params.timeoutMs,
      githubToken: params.githubToken,
    }).catch(() => [])

    const fallbackPaths = pickFallbackMarkdownPaths(treePaths, Math.max(params.maxDocs, 12))
      .filter((path) => !primaryPaths.includes(path))

    if (fallbackPaths.length > 0) {
      const fallbackDocuments = await collectGitHubMarkdown({
        owner: repo.owner,
        repo: repo.repo,
        defaultBranch,
        paths: fallbackPaths,
        timeoutMs: params.timeoutMs,
      })

      for (const document of fallbackDocuments) {
        documents.push(document)
        sources.push({ kind: document.kind, url: document.url })
      }
    }
  }

  return {
    providerType: requestedProviderType,
    details,
    sources: dedupeSources(sources),
    documents,
  }
}

function extractProviderCredentialsHeuristically(
  material: ProviderResearchMaterial,
): ProviderCredentialExtractionResult {
  const aggregate = new Map<string, { score: number; occurrences: number }>()
  const credentialProviderType = normalizeProviderType(material.details.name)

  for (const document of material.documents) {
    const extracted = extractCandidateEnvVarsFromText({
      text: document.text,
      providerType: credentialProviderType,
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
  }

  const exactEnvVars = [...aggregate.entries()]
    .filter(([, value]) => value.score >= 3)
    .sort((a, b) => b[1].score - a[1].score || b[1].occurrences - a[1].occurrences)
    .map(([token]) => token)
    .slice(0, 25)

  const prefixEnvVars = inferPrefixEnvVars({
    providerType: credentialProviderType,
    exactEnvVars,
  })

  const hasOfficialEvidence = material.sources.some((source) =>
    source.kind === "terraform_registry" || source.kind === "github_repository_docs"
  )

  const confidence = exactEnvVars.length >= 2 && prefixEnvVars.length > 0 && hasOfficialEvidence
    ? "high"
    : exactEnvVars.length >= 1 && hasOfficialEvidence
      ? "medium"
      : "low"

  return {
    exactEnvVars,
    prefixEnvVars,
    confidence,
    reasoningSummary: buildReasoningSummary({
      provider: `${material.details.namespace}/${material.details.name}`,
      exactCount: exactEnvVars.length,
      prefixCount: prefixEnvVars.length,
      confidence,
    }),
  }
}

export async function discoverProviderCredentials(params: {
  providerType: string
  timeoutMs: number
  maxDocs: number
  githubToken?: string
  extractor?: (material: ProviderResearchMaterial) => Promise<ProviderCredentialExtractionResult>
}): Promise<ProviderDiscoveryRunResult> {
  const requestedProviderType = normalizeProviderType(params.providerType)
  if (!requestedProviderType) {
    return {
      status: "failed",
      confidence: "low",
      exactEnvVars: [],
      prefixEnvVars: [],
      sources: [],
      reasoningSummary: "Provider type was empty after normalization",
    }
  }

  const material = await collectProviderResearchMaterial({
    providerType: requestedProviderType,
    timeoutMs: params.timeoutMs,
    maxDocs: params.maxDocs,
    githubToken: params.githubToken,
  })
  if (!material) {
    return {
      status: "inconclusive",
      confidence: "low",
      displayName: requestedProviderType,
      exactEnvVars: [],
      prefixEnvVars: [],
      sources: [],
      reasoningSummary: "No exact provider match found in Terraform Registry",
    }
  }

  const extraction = params.extractor
    ? await params.extractor(material)
    : extractProviderCredentialsHeuristically(material)

  const confidence = extraction.exactEnvVars.length > 0
    ? extraction.confidence
    : "low"

  const status = extraction.exactEnvVars.length > 0 ? "succeeded" : "inconclusive"

  return {
    status,
    confidence,
    displayName: material.details.name,
    exactEnvVars: extraction.exactEnvVars,
    prefixEnvVars: extraction.prefixEnvVars,
    sources: material.sources,
    reasoningSummary: extraction.reasoningSummary,
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
