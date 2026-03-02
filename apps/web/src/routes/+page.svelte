<script lang="ts">
  import { browser } from "$app/environment"
  import { onDestroy, onMount } from "svelte"
  import { listPreviews, type Preview } from "$lib/api"
  import { statusConfig, formatRelativeTime, shortSha } from "$lib/status"

  let org = $state("lamalex")
  let repoFilter = $state("")
  let showInactive = $state(false)
  let yourHandle = $state("")
  let previews = $state<Preview[]>([])
  let loading = $state(false)
  let error = $state("")
  let stream: EventSource | null = null

  const ACTIVE_STATUSES = new Set(["pending", "planning", "applying", "ready", "failed"])

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
    loading = true
    error = ""
    try {
      const res = await listPreviews({
        org,
        repo: repoFilter || undefined,
      })
      previews = res.data
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      previews = []
    } finally {
      loading = false
    }
  }

  function groupStatus(workspaces: Preview[]): string {
    const statuses = new Set(workspaces.map((ws) => ws.status))
    if (statuses.has("failed")) return "failed"
    if (statuses.has("applying") || statuses.has("planning") || statuses.has("pending")) {
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

  const normalizedHandle = $derived(yourHandle.trim().toLowerCase())

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
    org = localStorage.getItem("yaffle.org") ?? org
    repoFilter = localStorage.getItem("yaffle.repo") ?? repoFilter
    yourHandle = localStorage.getItem("yaffle.handle") ?? yourHandle
    showInactive = localStorage.getItem("yaffle.showInactive") === "true"
  })

  onDestroy(() => {
    if (stream) stream.close()
  })

  function connectStream() {
    if (!browser) return
    if (stream) stream.close()

    const params = new URLSearchParams()
    params.set("org", org)
    if (repoFilter) params.set("repo", repoFilter)

    stream = new EventSource(`/api/previews/stream?${params.toString()}`)
    stream.addEventListener("update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { data: Preview[] }
        previews = payload.data
      } catch {
        // ignore malformed payloads
      }
    })
  }

  $effect(() => {
    org; repoFilter; showInactive; yourHandle;
    if (browser) {
      localStorage.setItem("yaffle.org", org)
      localStorage.setItem("yaffle.repo", repoFilter)
      localStorage.setItem("yaffle.handle", yourHandle)
      localStorage.setItem("yaffle.showInactive", String(showInactive))
    }
    load()
    connectStream()
  })
</script>

<div class="space-y-6">
  <section class="rounded-xl border border-border bg-gradient-to-br from-surface-raised via-surface to-surface px-5 py-4">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold">Preview groups</h1>
        <p class="text-sm text-text-muted mt-1">
          Active previews grouped by PR. Destroyed previews are hidden by default.
        </p>
      </div>
      <div class="text-right text-sm text-text-dim">
        <div class="font-mono text-xs">{activeGroups.length} groups</div>
        <div class="font-mono text-xs">{previews.length} workspaces</div>
      </div>
    </div>
  </section>

  <!-- Filters -->
  <div class="flex flex-wrap gap-3 items-center">
    <input
      type="text"
      bind:value={org}
      placeholder="org"
      class="bg-surface-raised border border-border rounded px-3 py-1.5 text-sm text-text
             placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-36"
    />
    <input
      type="text"
      bind:value={repoFilter}
      placeholder="repo"
      class="bg-surface-raised border border-border rounded px-3 py-1.5 text-sm text-text
             placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-52"
    />
    <input
      type="text"
      bind:value={yourHandle}
      placeholder="your handle"
      class="bg-surface-raised border border-border rounded px-3 py-1.5 text-sm text-text
             placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-40"
    />
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
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
                        <span class="font-mono">{cfg.icon}</span>
                        {cfg.label}
                      </span>
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
                      <span class="font-mono text-[10px] {wsCfg.color}">{wsCfg.icon}</span>
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
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
                        <span class="font-mono">{cfg.icon}</span>
                        {cfg.label}
                      </span>
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
                      <span class="font-mono text-[10px] {wsCfg.color}">{wsCfg.icon}</span>
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
                  <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
                    <span class="font-mono">{cfg.icon}</span>
                    {cfg.label}
                  </span>
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
                  <span class="font-mono text-[10px] {wsCfg.color}">{wsCfg.icon}</span>
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
