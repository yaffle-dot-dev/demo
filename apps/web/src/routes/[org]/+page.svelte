<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { onDestroy, onMount } from "svelte"
  import {
    listEnvironments,
    listPreviews,
    type EnvironmentGroup,
    type Preview,
  } from "$lib/api"
  import { statusConfig, formatRelativeTime, shortSha } from "$lib/status"
  import { getUserLogin, setLastOrg } from "$lib/auth"

  // Org comes from URL param - always defined since this is a [org] route
  const org = $derived(page.params.org ?? "")

  let showInactive = $state(false)
  let previews = $state<Preview[]>([])
  let environments = $state<EnvironmentGroup[]>([])
  let loading = $state(true)
  let error = $state("")
  let hasToken = $state<boolean | null>(null)
  let userHandle = $state<string | null>(null)
  let stream: EventSource | null = null

  const ACTIVE_STATUSES = new Set([
    "pending",
    "planning",
    "applying",
    "awaiting_approval",
    "ready",
    "failed",
  ])

  interface PreviewGroup {
    key: string
    repo: string
    prNumber: number
    branch: string
    headSha: string
    createdAt: string
    status: string
    authorLogin: string | null
    workspaces: Preview[]
  }

  async function load() {
    if (!browser) return
    hasToken = Boolean(localStorage.getItem("yaffle.accessToken"))
    if (!hasToken) {
      goto("/")
      return
    }
    loading = true
    error = ""
    try {
      const [previewsRes, envRes] = await Promise.all([
        listPreviews({ org }),
        listEnvironments({ org }),
      ])
      previews = previewsRes.data.filter((p) => p.prNumber !== 0)
      environments = envRes.data
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      previews = []
      environments = []
    } finally {
      loading = false
    }
  }

  async function refreshEnvironments() {
    try {
      const envRes = await listEnvironments({ org })
      environments = envRes.data
    } catch {
      environments = []
    }
  }

  function groupStatus(workspaces: Preview[]): string {
    const statuses = new Set(workspaces.map((ws) => ws.status))
    if (statuses.has("failed")) return "failed"
    if (
      statuses.has("applying") ||
      statuses.has("planning") ||
      statuses.has("pending") ||
      statuses.has("awaiting_approval")
    ) {
      return "applying"
    }
    if (statuses.has("destroying")) return "destroying"
    if (statuses.has("ready")) return "ready"
    if (statuses.has("destroyed")) return "destroyed"
    return "pending"
  }

  function groupPreviews(list: Preview[]): PreviewGroup[] {
    const map = new Map<string, PreviewGroup>()

    for (const preview of list) {
      const key = `${preview.repo}#${preview.prNumber}`
      const existing = map.get(key)
      const createdAt = existing
        ? new Date(existing.createdAt) > new Date(preview.createdAt)
          ? existing.createdAt
          : preview.createdAt
        : preview.createdAt

      const status = existing ? groupStatus([...existing.workspaces, preview]) : preview.status

      const headSha = existing?.headSha ?? preview.headSha
      const branch = existing?.branch ?? preview.branch
      const authorLogin = existing?.authorLogin ?? preview.authorLogin ?? null

      const group: PreviewGroup = {
        key,
        repo: preview.repo,
        prNumber: preview.prNumber,
        branch,
        headSha,
        createdAt,
        status,
        authorLogin,
        workspaces: existing ? [...existing.workspaces, preview] : [preview],
      }

      map.set(key, group)
    }

    return Array.from(map.values()).sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  }

  const activeGroups = $derived(
    groupPreviews(previews.filter((p) => (showInactive ? true : ACTIVE_STATUSES.has(p.status)))),
  )

  const normalizedHandle = $derived(userHandle?.trim().toLowerCase() ?? "")

  const yourGroups = $derived(
    normalizedHandle
      ? activeGroups.filter((g) => (g.authorLogin ?? "").toLowerCase() === normalizedHandle)
      : [],
  )

  const otherGroups = $derived(
    normalizedHandle
      ? activeGroups.filter((g) => (g.authorLogin ?? "").toLowerCase() !== normalizedHandle)
      : activeGroups,
  )

  onMount(() => {
    if (!browser) return
    hasToken = Boolean(localStorage.getItem("yaffle.accessToken"))
    userHandle = getUserLogin()
    showInactive = localStorage.getItem("yaffle.showInactive") === "true"
    // Remember this org as the last visited
    if (org) setLastOrg(org)
  })

  onDestroy(() => {
    if (stream) stream.close()
  })

  function connectStream() {
    if (!browser) return
    const token = localStorage.getItem("yaffle.accessToken")
    hasToken = Boolean(token)
    if (!hasToken || !org) return
    if (stream) stream.close()

    const params = new URLSearchParams()
    params.set("org", org)
    if (token) params.set("token", token)

    stream = new EventSource(`/api/previews/stream?${params.toString()}`)
    stream.addEventListener("update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { data: Preview[] }
        previews = payload.data.filter((p) => p.prNumber !== 0)
        refreshEnvironments()
      } catch {
        // ignore malformed payloads
      }
    })
    stream.addEventListener("error", (event) => {
      console.error("SSE stream error:", event)
    })
  }

  $effect(() => {
    org; showInactive;
    if (browser) {
      localStorage.setItem("yaffle.showInactive", String(showInactive))
    }
    load()
    connectStream()
  })
</script>

<div class="space-y-6">
  <section class="grid grid-cols-1 gap-4">
    <div class="rounded-xl border border-border bg-gradient-to-br from-surface-raised via-surface to-surface px-5 py-4">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold">Primary environments</h1>
          <p class="text-sm text-text-muted mt-1">
            Latest apply status for long-lived branches.
          </p>
        </div>
        <div class="text-right text-sm text-text-dim">
          <div class="font-mono text-xs">{environments.length} environments</div>
        </div>
      </div>

      {#if environments.length === 0}
        <div class="text-text-dim text-sm py-6">No environments yet.</div>
      {:else}
        <div class="mt-4 grid grid-cols-1 gap-3">
          {#each environments as env (env.repo + env.branch)}
            {@const cfg = statusConfig(env.status)}
            {@const showStatus = env.status !== "ready"}
            <div class="rounded-lg border border-border bg-surface p-3 hover:border-yaffle-500/40 transition-colors">
              <div class="flex items-start justify-between">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-text">{env.repo}</span>
                    <span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">
                      {env.branch}
                    </span>
                    {#if showStatus}
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
                        <span class="font-mono">{cfg.icon}</span>
                        {cfg.label}
                      </span>
                    {/if}
                  </div>
                  <div class="flex flex-wrap gap-4 text-xs text-text-dim mt-2">
                    <span class="font-mono">{shortSha(env.headSha)}</span>
                    <span>{formatRelativeTime(env.updatedAt)}</span>
                  </div>
                </div>
              </div>
              <div class="mt-3 flex flex-wrap gap-2">
                {#each env.workspaces as ws (ws.previewId)}
                  {@const wsCfg = statusConfig(ws.status)}
                  {@const wsShowStatus = ws.status !== "ready"}
                  <a
                    href="/previews/{ws.previewId}"
                    class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface-raised text-xs text-text-muted hover:text-text hover:border-yaffle-500/40 transition-colors"
                  >
                    {#if wsShowStatus}
                      <span class="font-mono text-[10px] {wsCfg.color}">{wsCfg.icon}</span>
                    {/if}
                    <span class="font-mono">{ws.workspacePath}</span>
                  </a>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="rounded-xl border border-border bg-gradient-to-br from-surface-raised via-surface to-surface px-5 py-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-xl font-semibold">Preview groups</h2>
          <p class="text-sm text-text-muted mt-1">
            Active previews grouped by PR. Destroyed previews are hidden by default.
          </p>
        </div>
        <div class="text-right text-sm text-text-dim">
          <div class="font-mono text-xs">{activeGroups.length} groups</div>
          <div class="font-mono text-xs">{previews.length} workspaces</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Filter: just show destroyed toggle -->
  <div class="flex items-center">
    <label class="flex items-center gap-2 text-sm text-text-muted">
      <input type="checkbox" bind:checked={showInactive} />
      Show destroyed
    </label>
  </div>

  <!-- Error -->
  {#if error}
    <div class="bg-red-950/50 border border-red-800 rounded px-4 py-3 text-sm text-red-300">
      {error}
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="text-text-muted text-sm">Loading...</div>
  {:else if activeGroups.length === 0}
    <div class="text-text-dim text-sm py-10 text-center">
      Waiting for your first preview or deployment.
    </div>
  {:else}
    {#if normalizedHandle}
      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-medium text-text-muted">Your active previews</h2>
          <span class="text-xs text-text-dim">{yourGroups.length} groups</span>
        </div>
        {#if yourGroups.length === 0}
          <div class="text-text-dim text-sm py-6 text-center">No previews for @{normalizedHandle}.</div>
        {:else}
          <div class="grid grid-cols-1 gap-4">
            {#each yourGroups as group (group.key)}
              {@const cfg = statusConfig(group.status)}
              <div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors">
                <div class="flex items-start justify-between">
                  <div>
                    <div class="flex items-center gap-3">
                      <a href="/previews/{group.workspaces[0].id}" class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
                        {group.repo}
                      </a>
                      <span class="font-mono text-sm text-text-muted">#{group.prNumber}</span>
                      {#if group.status !== "ready"}
                        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
                          <span class="font-mono">{cfg.icon}</span>
                          {cfg.label}
                        </span>
                      {/if}
                    </div>
                    <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2">
                      <span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">
                        {group.branch}
                      </span>
                      <span class="font-mono text-xs text-text-dim">{shortSha(group.headSha)}</span>
                      <span class="text-text-dim text-xs">{formatRelativeTime(group.createdAt)}</span>
                    </div>
                  </div>
                  <div class="text-right text-xs text-text-dim">
                    {group.workspaces.length} workspace{group.workspaces.length === 1 ? "" : "s"}
                  </div>
                </div>

                <div class="mt-4 flex flex-wrap gap-2">
                  {#each group.workspaces as ws (ws.id)}
                    {@const wsCfg = statusConfig(ws.status)}
                    <a href="/previews/{ws.id}" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors">
                      {#if ws.status !== "ready"}<span class="font-mono text-[10px] {wsCfg.color}">{wsCfg.icon}</span>{/if}
                      <span class="font-mono">{ws.workspacePath}</span>
                    </a>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-medium text-text-muted">Other active previews</h2>
          <span class="text-xs text-text-dim">{otherGroups.length} groups</span>
        </div>
        {#if otherGroups.length === 0}
          <div class="text-text-dim text-sm py-6 text-center">No other active previews.</div>
        {:else}
          <div class="grid grid-cols-1 gap-4">
            {#each otherGroups as group (group.key)}
              {@const cfg = statusConfig(group.status)}
              <div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors">
                <div class="flex items-start justify-between">
                  <div>
                    <div class="flex items-center gap-3">
                      <a href="/previews/{group.workspaces[0].id}" class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
                        {group.repo}
                      </a>
                      <span class="font-mono text-sm text-text-muted">#{group.prNumber}</span>
                      {#if group.status !== "ready"}
                        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
                          <span class="font-mono">{cfg.icon}</span>
                          {cfg.label}
                        </span>
                      {/if}
                    </div>
                    <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2">
                      <span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">
                        {group.branch}
                      </span>
                      <span class="font-mono text-xs text-text-dim">{shortSha(group.headSha)}</span>
                      <span class="text-text-dim text-xs">{formatRelativeTime(group.createdAt)}</span>
                      {#if group.authorLogin}
                        <span class="text-text-dim text-xs">@{group.authorLogin}</span>
                      {/if}
                    </div>
                  </div>
                  <div class="text-right text-xs text-text-dim">
                    {group.workspaces.length} workspace{group.workspaces.length === 1 ? "" : "s"}
                  </div>
                </div>

                <div class="mt-4 flex flex-wrap gap-2">
                  {#each group.workspaces as ws (ws.id)}
                    {@const wsCfg = statusConfig(ws.status)}
                    <a href="/previews/{ws.id}" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors">
                      {#if ws.status !== "ready"}
                        <span class="font-mono text-[10px] {wsCfg.color}">{wsCfg.icon}</span>
                      {/if}
                      <span class="font-mono">{ws.workspacePath}</span>
                    </a>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {:else}
      <!-- No user handle - show all previews without yours/others split -->
      <div class="grid grid-cols-1 gap-4">
        {#each activeGroups as group (group.key)}
          {@const cfg = statusConfig(group.status)}
          <div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors">
            <div class="flex items-start justify-between">
              <div>
                <div class="flex items-center gap-3">
                  <a href="/previews/{group.workspaces[0].id}" class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
                    {group.repo}
                  </a>
                  <span class="font-mono text-sm text-text-muted">#{group.prNumber}</span>
                  {#if group.status !== "ready"}
                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
                      <span class="font-mono">{cfg.icon}</span>
                      {cfg.label}
                    </span>
                  {/if}
                </div>
                <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2">
                  <span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">
                    {group.branch}
                  </span>
                  <span class="font-mono text-xs text-text-dim">{shortSha(group.headSha)}</span>
                  <span class="text-text-dim text-xs">{formatRelativeTime(group.createdAt)}</span>
                  {#if group.authorLogin}
                    <span class="text-text-dim text-xs">@{group.authorLogin}</span>
                  {/if}
                </div>
              </div>
              <div class="text-right text-xs text-text-dim">
                {group.workspaces.length} workspace{group.workspaces.length === 1 ? "" : "s"}
              </div>
            </div>

            <div class="mt-4 flex flex-wrap gap-2">
              {#each group.workspaces as ws (ws.id)}
                {@const wsCfg = statusConfig(ws.status)}
                <a href="/previews/{ws.id}" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors">
                  {#if ws.status !== "ready"}
                    <span class="font-mono text-[10px] {wsCfg.color}">{wsCfg.icon}</span>
                  {/if}
                  <span class="font-mono">{ws.workspacePath}</span>
                </a>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
