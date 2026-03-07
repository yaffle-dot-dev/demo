<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"
  import {
    listEnvironments,
    getMe,
    type EnvironmentGroup,
    type Preview,
  } from "$lib/api"
  import { usePreviewListStream } from "$lib/sse/index.svelte"
  import { statusConfig, formatRelativeTime, shortSha } from "$lib/status"
  import { useSession, setLastOrg } from "$lib/auth"

  // Org comes from URL param - always defined since this is a [org] route
  const org = $derived(page.params.org ?? "")

  let showInactive = $state(false)
  let environments = $state<EnvironmentGroup[]>([])
  let loading = $state(true)
  let error = $state("")
  
  // Current user's GitHub ID for matching "your" previews
  let myGithubId = $state<number | null>(null)

  // BetterAuth session store
  const session = useSession()

  // SSE hook replaces inline EventSource management
  const stream = usePreviewListStream(() => org)

  // Use SSE data for previews (filtered to exclude env previews)
  const previews = $derived(stream.previews.filter((p) => p.prNumber !== 0))

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
    /** GitHub user ID of the PR author (stable identifier) */
    authorGithubId: number | null
    /** GitHub username of the PR author (for display) */
    authorLogin: string | null
    workspaces: Preview[]
  }

  async function load() {
    if (!browser) return
    loading = true
    error = ""
    try {
      // Fetch user's GitHub ID and environments in parallel
      const [meRes, envRes] = await Promise.all([
        getMe(),
        listEnvironments({ org }),
      ])
      myGithubId = meRes.data.githubId
      environments = envRes.data
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
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

  // Refresh environments when preview SSE data changes
  $effect(() => {
    // Track the previews array - when SSE pushes new data, also refresh envs
    void stream.previews
    if (browser && stream.previews.length > 0) {
      refreshEnvironments()
    }
  })

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
      const authorGithubId = existing?.authorGithubId ?? preview.authorGithubId ?? null
      const authorLogin = existing?.authorLogin ?? preview.authorLogin ?? null

      const group: PreviewGroup = {
        key,
        repo: preview.repo,
        prNumber: preview.prNumber,
        branch,
        headSha,
        createdAt,
        status,
        authorGithubId,
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

  // Filter groups by GitHub ID (stable) instead of username (can change)
  const yourGroups = $derived(
    myGithubId
      ? activeGroups.filter((g) => g.authorGithubId === myGithubId)
      : [],
  )

  const otherGroups = $derived(
    myGithubId
      ? activeGroups.filter((g) => g.authorGithubId !== myGithubId)
      : activeGroups,
  )

  let hasLoaded = false

  onMount(() => {
    if (!browser) return
    showInactive = localStorage.getItem("yaffle.showInactive") === "true"
    // Remember this org as the last visited
    if (org) setLastOrg(org)

    // Subscribe to session and load when ready
    const unsubscribe = session.subscribe((state) => {
      if (state.isPending) return
      if (hasLoaded) return
      hasLoaded = true

      if (!state.data?.user) {
        goto(`${base}/`)
        return
      }
      load()
    })

    return unsubscribe
  })

  // Persist showInactive preference
  $effect(() => {
    void showInactive
    if (browser) {
      localStorage.setItem("yaffle.showInactive", String(showInactive))
    }
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
                    href="{base}/{org}/{env.repo}/env/{env.branch}?ws={encodeURIComponent(ws.workspacePath)}"
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
    {#if myGithubId}
      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-medium text-text-muted">Your active previews</h2>
          <span class="text-xs text-text-dim">{yourGroups.length} groups</span>
        </div>
        {#if yourGroups.length === 0}
          <div class="text-text-dim text-sm py-6 text-center">No active previews.</div>
        {:else}
          <div class="grid grid-cols-1 gap-4">
            {#each yourGroups as group (group.key)}
              {@const cfg = statusConfig(group.status)}
              <div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors">
                <div class="flex items-start justify-between">
                  <div>
                    <div class="flex items-center gap-3">
                      <a href="{base}/{org}/{group.repo}/pr/{group.prNumber}" class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
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
                    <a href="{base}/{org}/{group.repo}/pr/{group.prNumber}?ws={encodeURIComponent(ws.workspacePath)}" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors">
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
                      <a href="{base}/{org}/{group.repo}/pr/{group.prNumber}" class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
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
                    <a href="{base}/{org}/{group.repo}/pr/{group.prNumber}?ws={encodeURIComponent(ws.workspacePath)}" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors">
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
                  <a href="{base}/{org}/{group.repo}/pr/{group.prNumber}" class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
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
                <a href="{base}/{org}/{group.repo}/pr/{group.prNumber}?ws={encodeURIComponent(ws.workspacePath)}" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors">
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
