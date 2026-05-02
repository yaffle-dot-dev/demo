<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"
  import {
    listEnvironments,
    getMe,
    listOrgs,
    type EnvironmentGroup,
    type Preview,
    type DependencyGraph,
  } from "$lib/api"
  import { githubTreeUrl, githubCommitUrl } from "$lib/github"
  import { usePreviewListStream, useOrgStatusStream } from "$lib/sse/index.svelte"
  import { formatRelativeTime, shortSha } from "$lib/status"
  import { useSession, setLastOrg } from "$lib/auth"
  import WorkspaceDag from "$lib/components/WorkspaceDag.svelte"
  import ProvisioningStatus from "$lib/components/ProvisioningStatus.svelte"
  import RunGroupStatusBadge from "$lib/components/RunGroupStatusBadge.svelte"
  import RefBadge from "$lib/components/RefBadge.svelte"
  import AsyncLoader from "$lib/components/AsyncLoader.svelte"
  import ConnectionBlockedBadge from "$lib/components/ConnectionBlockedBadge.svelte"
  import PlanLimitedBadge from "$lib/components/PlanLimitedBadge.svelte"
  import {
    summarizeEnvironmentDegradation,
  } from "$lib/environment-degradation"

  type PageData = {
    initialEnvironments: EnvironmentGroup[]
    initialPreviews: Preview[]
    initialDependencyGraphs: Record<string, DependencyGraph>
  }

  let { data }: { data: PageData } = $props()

  // Org comes from URL param - always defined since this is a [org] route
  const org = $derived(page.params.org ?? "")

  let showInactive = $state(false)
  let environments = $state<EnvironmentGroup[]>([])
  let loading = $state(false)
  let pageError = $state("")
  let namedEnvironmentsError = $state("")
  let namedRefreshInFlight = false
  let namedRefreshQueued = false
  let namedRefreshTimer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    environments = data.initialEnvironments
  })
  
  // Current user's GitHub ID for matching "your" PR environments
  let myGithubId = $state<number | null>(null)
  let canManageConnections = $state(false)

  // BetterAuth session store
  const session = useSession()

  // SSE hook replaces inline EventSource management
  const stream = usePreviewListStream(() => org)
  
  // SSE hook for org provisioning status
  const orgStatus = useOrgStatusStream(() => org)
  
  // Derived: is org ready to use?
  const isOrgReady = $derived(orgStatus.status === "active" || orgStatus.status === null)

  const previewSource = $derived(
    stream.hasReceivedSnapshot ? stream.previews : data.initialPreviews,
  )

  const dependencyGraphSource = $derived(
    stream.hasReceivedSnapshot ? stream.dependencyGraphs : data.initialDependencyGraphs,
  )

  // Use live SSE data once it has produced a snapshot; otherwise render initial payload.
  const previews = $derived(previewSource.filter((p) => p.prNumber != null && p.prNumber > 0))

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
    prNumber: number | null
    environmentName: string
    ref: string
    headSha: string
    headUpdatedAt: string
    /** GitHub user ID of the PR author (stable identifier) */
    authorGithubId: number | null
    /** GitHub username of the PR author (for display) */
    authorLogin: string | null
    workspaces: Preview[]
  }
  
  /** Extract display name from a full ref (e.g., "refs/heads/main" -> "main") */
  function refName(ref: string): string {
    return ref.replace(/^refs\/(heads|tags)\//, "")
  }

  async function loadUserContext() {
    if (!browser) return
    try {
      const [meRes, orgsRes] = await Promise.all([
        getMe(),
        listOrgs(),
      ])
      myGithubId = meRes.data.githubId
      const orgRole = orgsRes.data.find((item) => item.slug === org)?.role ?? ""
      canManageConnections = orgRole === "admin"
    } catch (e) {
      pageError = e instanceof Error ? e.message : String(e)
    }
  }

  async function refreshEnvironments() {
    if (namedRefreshInFlight) {
      namedRefreshQueued = true
      return
    }

    namedRefreshInFlight = true

    try {
      const envRes = await listEnvironments({ org })
      environments = envRes.data
      namedEnvironmentsError = ""
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      namedEnvironmentsError = `Named environments could not refresh. Showing last known data. ${message}`
    } finally {
      namedRefreshInFlight = false

      if (namedRefreshQueued) {
        namedRefreshQueued = false
        scheduleEnvironmentsRefresh(250)
      }
    }
  }

  function scheduleEnvironmentsRefresh(delayMs = 750) {
    if (!browser) {
      return
    }

    if (namedRefreshTimer) {
      clearTimeout(namedRefreshTimer)
    }

    namedRefreshTimer = setTimeout(() => {
      namedRefreshTimer = null
      void refreshEnvironments()
    }, delayMs)
  }

  // Refresh environments when preview SSE data changes
  $effect(() => {
    void stream.hasReceivedSnapshot
    void stream.previews
    if (browser && stream.hasReceivedSnapshot) {
      scheduleEnvironmentsRefresh()
    }
  })

  function groupPreviews(list: Preview[]): PreviewGroup[] {
    const map = new Map<string, PreviewGroup>()

    for (const preview of list) {
      const key = `${preview.repo}:${preview.environmentName}`
      const existing = map.get(key)
      const candidateTime = new Date(preview.headUpdatedAt).getTime()
      const existingTime = existing ? new Date(existing.headUpdatedAt).getTime() : Number.NEGATIVE_INFINITY
      const usePreviewHead = candidateTime >= existingTime

      const headUpdatedAt = existing && !usePreviewHead
        ? existing.headUpdatedAt
        : preview.headUpdatedAt
      const headSha = usePreviewHead ? preview.headSha : existing!.headSha
      const ref = usePreviewHead ? preview.ref : existing!.ref
      const authorGithubId = usePreviewHead
        ? preview.authorGithubId ?? existing?.authorGithubId ?? null
        : existing!.authorGithubId
      const authorLogin = usePreviewHead
        ? preview.authorLogin ?? existing?.authorLogin ?? null
        : existing!.authorLogin

      const group: PreviewGroup = {
        key,
        repo: preview.repo,
        prNumber: preview.prNumber,
        environmentName: preview.environmentName,
        ref,
        headSha,
        headUpdatedAt,
        authorGithubId,
        authorLogin,
        workspaces: existing ? [...existing.workspaces, preview] : [preview],
      }

      map.set(key, group)
    }

    return Array.from(map.values()).sort((a, b) => {
      return new Date(b.headUpdatedAt).getTime() - new Date(a.headUpdatedAt).getTime()
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

  // Helper to get dependency graph for a PR group
  function getDependencyGraph(repo: string, environmentName: string): DependencyGraph | null {
    const key = `${repo}:${environmentName}`
    return dependencyGraphSource[key] ?? null
  }

  function countConnectionBlockedWorkspaces(env: EnvironmentGroup): number {
    return env.workspaces.filter(
      (workspace) => workspace.connectionStatus === "missing",
    ).length
  }

  function listMissingProviders(env: EnvironmentGroup): string {
    const providers = new Set<string>()
    for (const workspace of env.workspaces) {
      for (const provider of workspace.missingProviders) {
        providers.add(provider)
      }
    }
    return [...providers].sort().join(", ")
  }

  function missingProvidersForEnv(env: EnvironmentGroup): string[] {
    const providers = listMissingProviders(env)
    if (!providers) {
      return []
    }
    return providers.split(", ").filter(Boolean)
  }

  function listUsedConnections(env: EnvironmentGroup): string {
    const names = new Set<string>()
    for (const workspace of env.workspaces) {
      for (const connection of workspace.matchedConnections) {
        names.add(connection.name)
      }
    }
    return [...names].sort().join(", ")
  }

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
      void loadUserContext()
    })

    return () => {
      if (namedRefreshTimer) {
        clearTimeout(namedRefreshTimer)
      }
      unsubscribe()
    }
  })

  // Persist showInactive preference
  $effect(() => {
    void showInactive
    if (browser) {
      localStorage.setItem("yaffle.showInactive", String(showInactive))
    }
  })
</script>

<!-- Show provisioning status if org is not ready -->
{#if !isOrgReady}
  <ProvisioningStatus
    status={orgStatus.status}
    error={orgStatus.error}
  />
{:else}
<div class="space-y-6">
  <section class="grid grid-cols-1 gap-4">
    <div class="rounded-xl border border-border bg-gradient-to-br from-surface-raised via-surface to-surface px-5 py-4">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-semibold">Named environments</h1>
        </div>
        <div class="text-right text-sm text-text-dim">
          <div class="font-mono text-xs">{environments.length} environments</div>
        </div>
      </div>

      {#if namedEnvironmentsError}
        <div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {namedEnvironmentsError}
        </div>
      {/if}

      {#if loading}
        <div class="mt-4">
          <AsyncLoader
            title="Loading environments"
            message="Fetching latest workspace status and dependency graphs."
          />
        </div>
      {:else if environments.length === 0}
        <div class="text-text-dim text-sm py-6">No environments yet.</div>
      {:else}
        <div class="mt-4 grid grid-cols-1 gap-3">
          {#each environments as env (env.repo + env.environmentName)}
            {@const degradationSummary = summarizeEnvironmentDegradation(env)}
            <div class={`rounded-lg border bg-surface p-3 transition-colors hover:border-yaffle-500/40 ${degradationSummary ? "border-amber-500/40" : "border-border"}`}>
              <div class="flex items-start justify-between">
                <div>
                  <div class="flex items-center gap-2">
                    <a href={`${base}/${org}/${env.repo}/env/${env.environmentName}`} class="font-medium text-text hover:text-yaffle-400 transition-colors">{env.repo}</a>
                    <RefBadge label={env.environmentName} href={githubTreeUrl({ org, repo: env.repo }, refName(env.ref))} />
                    <RunGroupStatusBadge statuses={env.workspaces.map(w => w.status)} />
                    {#if degradationSummary}
                      <span class="rounded px-2 py-0.5 text-xs font-medium bg-amber-500/15 text-amber-200">
                        {degradationSummary.totalWorkspaces} degraded workspace{degradationSummary.totalWorkspaces === 1 ? "" : "s"}
                      </span>
                    {/if}
                    {#if countConnectionBlockedWorkspaces(env) > 0}
                      <ConnectionBlockedBadge
                        {org}
                        blockedCount={countConnectionBlockedWorkspaces(env)}
                        providers={missingProvidersForEnv(env)}
                        {canManageConnections}
                      />
                    {/if}
                    {#if env.workspaces.some(w => w.status === "plan_limited")}
                      <PlanLimitedBadge {org} />
                    {/if}
                  </div>
                  <div class="flex flex-wrap gap-4 text-xs text-text-dim mt-2">
                    <a 
                      href={githubCommitUrl({ org, repo: env.repo }, env.headSha)}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-mono hover:text-yaffle-400 transition-colors"
                    >
                      {shortSha(env.headSha)}
                    </a>
                    <span>{formatRelativeTime(env.updatedAt)}</span>
                  </div>
                  {#if listUsedConnections(env)}
                    <div class="mt-2 text-xs text-text-dim">
                      Using: {listUsedConnections(env)}
                    </div>
                  {/if}

                  {#if degradationSummary}
                    <div class="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      <div class="font-medium">Some workspace metadata could not be loaded.</div>
                      {#each degradationSummary.groups as group}
                        <div class="mt-2">
                          <div>{group.message}</div>
                          <div class="mt-1 font-mono text-[11px] text-amber-100/90">
                            Affected: {group.workspaces.join(", ")}
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
              <div class="mt-3">
                <WorkspaceDag
                  {org}
                  repo={env.repo}
                  environmentName={env.environmentName}
                  workspaces={env.workspaces}
                  dependencyGraph={env.dependencyGraph ?? getDependencyGraph(env.repo, env.environmentName)}
                />
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="rounded-xl border border-border bg-gradient-to-br from-surface-raised via-surface to-surface px-5 py-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-xl font-semibold">Transient environments</h2>
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
  {#if pageError}
    <div class="bg-red-950/50 border border-red-800 rounded px-4 py-3 text-sm text-red-300">
      {pageError}
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <AsyncLoader
      title="Loading transient environments"
      message="Pulling active PR run groups and workspace updates."
    />
  {:else if activeGroups.length === 0}
    <div class="text-text-dim text-sm py-10 text-center">
      No active PR environments.
    </div>
  {:else}
    {#if myGithubId}
      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-medium text-text-muted">Your PRs</h2>
          <span class="text-xs text-text-dim">{yourGroups.length} groups</span>
        </div>
        {#if yourGroups.length === 0}
          <div class="text-text-dim text-sm py-6 text-center">No active PR environments.</div>
        {:else}
          <div class="grid grid-cols-1 gap-4">
            {#each yourGroups as group (group.key)}
              <div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors">
                <div class="flex items-start justify-between">
                  <div>
                    <div class="flex items-center gap-3">
                      <a href={`${base}/${org}/${group.repo}/env/${group.environmentName}`} class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
                        {group.repo}
                      </a>
                      <span class="font-mono text-sm text-text-muted">{group.prNumber != null ? `#${group.prNumber}` : group.environmentName}</span>
                      <RunGroupStatusBadge statuses={group.workspaces.map(w => w.status)} />
                      {#if group.workspaces.some(w => w.status === "plan_limited")}
                        <PlanLimitedBadge {org} />
                      {/if}
                    </div>
                    <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2">
                      <span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">
                        {refName(group.ref)}
                      </span>
                      <span class="font-mono text-xs text-text-dim">{shortSha(group.headSha)}</span>
                      <span class="text-text-dim text-xs">{formatRelativeTime(group.headUpdatedAt)}</span>
                    </div>
                  </div>
                  <div class="text-right text-xs text-text-dim">
                    {group.workspaces.length} workspace{group.workspaces.length === 1 ? "" : "s"}
                  </div>
                </div>

                <div class="mt-3">
                  <WorkspaceDag
                    {org}
                    repo={group.repo}
                    environmentName={group.environmentName}
                    workspaces={group.workspaces}
                    dependencyGraph={getDependencyGraph(group.repo, group.environmentName)}
                  />
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-medium text-text-muted">Other PRs</h2>
          <span class="text-xs text-text-dim">{otherGroups.length} groups</span>
        </div>
        {#if otherGroups.length === 0}
          <div class="text-text-dim text-sm py-6 text-center">No other active PR environments.</div>
        {:else}
          <div class="grid grid-cols-1 gap-4">
            {#each otherGroups as group (group.key)}
              <div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors">
                <div class="flex items-start justify-between">
                  <div>
                    <div class="flex items-center gap-3">
                      <a href={`${base}/${org}/${group.repo}/env/${group.environmentName}`} class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
                        {group.repo}
                      </a>
                      <span class="font-mono text-sm text-text-muted">{group.prNumber != null ? `#${group.prNumber}` : group.environmentName}</span>
                      <RunGroupStatusBadge statuses={group.workspaces.map(w => w.status)} />
                      {#if group.workspaces.some(w => w.status === "plan_limited")}
                        <PlanLimitedBadge {org} />
                      {/if}
                    </div>
                    <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2">
                      <span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">
                        {refName(group.ref)}
                      </span>
                      <span class="font-mono text-xs text-text-dim">{shortSha(group.headSha)}</span>
                      <span class="text-text-dim text-xs">{formatRelativeTime(group.headUpdatedAt)}</span>
                      {#if group.authorLogin}
                        <span class="text-text-dim text-xs">@{group.authorLogin}</span>
                      {/if}
                    </div>
                  </div>
                  <div class="text-right text-xs text-text-dim">
                    {group.workspaces.length} workspace{group.workspaces.length === 1 ? "" : "s"}
                  </div>
                </div>

                <div class="mt-3">
                  <WorkspaceDag
                    {org}
                    repo={group.repo}
                    environmentName={group.environmentName}
                    workspaces={group.workspaces}
                    dependencyGraph={getDependencyGraph(group.repo, group.environmentName)}
                  />
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {:else}
      <!-- No user handle - show all PR environments without yours/others split -->
      <div class="grid grid-cols-1 gap-4">
        {#each activeGroups as group (group.key)}
          <div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors">
            <div class="flex items-start justify-between">
              <div>
                <div class="flex items-center gap-3">
                  <a href={`${base}/${org}/${group.repo}/env/${group.environmentName}`} class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">
                    {group.repo}
                  </a>
                  <span class="font-mono text-sm text-text-muted">{group.prNumber != null ? `#${group.prNumber}` : group.environmentName}</span>
                  <RunGroupStatusBadge statuses={group.workspaces.map(w => w.status)} />
                  {#if group.workspaces.some(w => w.status === "plan_limited")}
                    <PlanLimitedBadge {org} />
                  {/if}
                </div>
                <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2">
                      <span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">
                        {refName(group.ref)}
                      </span>
                  <span class="font-mono text-xs text-text-dim">{shortSha(group.headSha)}</span>
                  <span class="text-text-dim text-xs">{formatRelativeTime(group.headUpdatedAt)}</span>
                  {#if group.authorLogin}
                    <span class="text-text-dim text-xs">@{group.authorLogin}</span>
                  {/if}
                </div>
              </div>
              <div class="text-right text-xs text-text-dim">
                {group.workspaces.length} workspace{group.workspaces.length === 1 ? "" : "s"}
              </div>
            </div>

            <div class="mt-3">
              <WorkspaceDag
                {org}
                repo={group.repo}
                environmentName={group.environmentName}
                workspaces={group.workspaces}
                dependencyGraph={getDependencyGraph(group.repo, group.environmentName)}
              />
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
{/if}
