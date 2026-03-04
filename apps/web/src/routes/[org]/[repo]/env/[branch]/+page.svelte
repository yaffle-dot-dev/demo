<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/stores"
  import { onMount } from "svelte"
  import { getPreviewsByEnv, type EnvPreviewGroup } from "$lib/api"
  import PreviewGroupPage from "$lib/components/PreviewGroupPage.svelte"
  import { shortSha } from "$lib/status"

  // Live data from SSE - always up to date
  let liveData = $state<EnvPreviewGroup | null>(null)
  // Viewed data - what the user is currently looking at (may be pinned to older SHA)
  let viewedData = $state<EnvPreviewGroup | null>(null)
  // The SHA the user is currently viewing
  let viewedSha = $state<string | null>(null)

  let loading = $state(true)
  let error = $state("")
  let stream: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let mounted = false

  // Reactive params
  const org = $derived($page.params.org ?? "")
  const repo = $derived($page.params.repo ?? "")
  const branch = $derived($page.params.branch ?? "")

  // GitHub URL for repo (not PR)
  const githubUrl = $derived(`https://github.com/${repo}`)

  // Check if there's a newer run available
  const hasNewerRun = $derived(
    liveData && viewedData && liveData.headSha !== viewedData.headSha
  )

  // Check if a run is currently in progress on the live data
  const liveRunInProgress = $derived(
    liveData?.workspaces.some((ws) =>
      ws.runs.some((r) => r.status === "running" || r.status === "pending")
    ) ?? false
  )

  // The data we display - viewedData if pinned, otherwise liveData
  const displayData = $derived(viewedData ?? liveData)

  // Load data and connect stream on mount
  onMount(() => {
    mounted = true
    if (browser && org && repo && branch) {
      loadData()
      connectStream()
    }

    // Pause SSE when tab is hidden, resume when visible
    function handleVisibilityChange() {
      if (document.hidden) {
        disconnectStream()
      } else if (mounted) {
        connectStream()
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)

    // Cleanup on unmount
    return () => {
      mounted = false
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      disconnectStream()
    }
  })

  async function loadData() {
    loading = true
    error = ""
    try {
      const res = await getPreviewsByEnv(org, repo, branch)
      liveData = res.data
      // On initial load, view the current data
      viewedData = res.data
      viewedSha = res.data?.headSha ?? null
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  function disconnectStream() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    stream?.close()
    stream = null
  }

  function connectStream() {
    if (!browser || !mounted) return
    // Tear down any existing connection and pending reconnect
    disconnectStream()

    const token = localStorage.getItem("yaffle.accessToken")
    const params = token ? `?token=${encodeURIComponent(token)}` : ""
    const url = `/api/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/env/${encodeURIComponent(branch)}/stream${params}`

    const es = new EventSource(url)
    stream = es

    es.addEventListener("update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { data: EnvPreviewGroup | null }
        if (payload.data) {
          liveData = payload.data

          // If user is viewing current SHA, update viewedData too (for log streaming)
          if (viewedSha === payload.data.headSha) {
            viewedData = payload.data
          }
        }
      } catch {
        // Ignore malformed payloads
      }
    })

    es.addEventListener("error", () => {
      // Only handle if this is still the active stream (prevent stale handlers)
      if (stream !== es) return
      disconnectStream()
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (browser && mounted && !document.hidden) connectStream()
      }, 5000)
    })
  }

  function switchToLiveRun() {
    if (liveData) {
      viewedData = liveData
      viewedSha = liveData.headSha
    }
  }
</script>

<svelte:head>
  <title>{branch} - {repo} - Yaffle</title>
</svelte:head>

{#if loading && !displayData}
  <div class="flex items-center justify-center h-full text-text-muted">
    Loading...
  </div>
{:else if error}
  <div class="flex items-center justify-center h-full">
    <div class="bg-red-950/50 border border-red-800 rounded px-6 py-4 text-sm text-red-300 max-w-md">
      <div class="font-medium mb-1">Error loading environment</div>
      <div class="text-red-400">{error}</div>
    </div>
  </div>
{:else if displayData}
  <!-- New run available banner -->
  {#if hasNewerRun && liveData}
    <div class="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
      <button
        onclick={switchToLiveRun}
        class="flex items-center gap-2 px-4 py-2 bg-yaffle-600 hover:bg-yaffle-500 text-white rounded-full shadow-lg transition-colors text-sm font-medium"
      >
        {#if liveRunInProgress}
          <span class="inline-block w-2 h-2 bg-white rounded-full animate-pulse"></span>
          New run in progress
        {:else}
          New run available
        {/if}
        <span class="font-mono text-xs opacity-75">@{shortSha(liveData.headSha)}</span>
        <span>-></span>
      </button>
    </div>
  {/if}

  <PreviewGroupPage
    type="env"
    {org}
    repo={displayData.repo}
    identifier={displayData.branch}
    branch={displayData.branch}
    headSha={displayData.headSha}
    workspaces={displayData.workspaces}
    {githubUrl}
    streaming={true}
  />
{:else}
  <div class="flex items-center justify-center h-full text-text-dim">
    No preview data found for this environment.
  </div>
{/if}
