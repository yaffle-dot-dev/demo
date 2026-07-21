<script lang="ts">
  import { browser } from "$app/environment"
  import { onMount } from "svelte"
  import { page } from "$app/stores"
  import {
    createRunViewPageId,
    createRunViewTelemetryClient,
    getOrCreateRunViewSessionId,
  } from "$lib/run-view-monitoring"
  import { usePreviewStream } from "$lib/sse/index.svelte"
  import { getLatestRunGroup } from "$lib/sse/types"
  import { githubRepoUrl, githubPullUrl } from "$lib/github"
  import { listOrgs } from "$lib/api"
  import type { EnvironmentPreviewGroup } from "$lib/api"
  import AsyncLoader from "$lib/components/AsyncLoader.svelte"
  import PreviewGroupPage from "$lib/components/PreviewGroupPage.svelte"
  import { canMutateInfrastructure as roleCanMutateInfrastructure } from "$lib/execution-permissions"

  type PageData = {
    initialEnvironment: EnvironmentPreviewGroup | null
  }

  let { data }: { data: PageData } = $props()
  let initialEnvironment = $state<EnvironmentPreviewGroup | null>(null)

  // Reactive params
  const org = $derived($page.params.org ?? "")
  const repo = $derived($page.params.repo ?? "")
  const environmentName = $derived($page.params.name ?? "")
  const requestedRunGroupId = $derived($page.url.searchParams.get("runGroupId"))

  const runViewSessionId = $state(browser ? getOrCreateRunViewSessionId() : null)
  const pageViewId = $state(browser ? createRunViewPageId() : null)
  const runViewStartMs = $state(browser ? performance.now() : null)
  const LONG_TASK_THRESHOLD_MS = 100
  let lastVisibleAtMs = $state<number | null>(browser ? performance.now() : null)
  const trackRunViewEvent = createRunViewTelemetryClient(() => ({
    org,
    repo,
    environmentName,
    correlation: { runViewSessionId, pageViewId },
  }))

  // Single hook replaces all inline SSE code - uses unified "environment" endpoint
  const stream = usePreviewStream(
    () => org,
    () => repo,
    "environment",
    () => environmentName,
    () => runViewSessionId,
    () => pageViewId,
  )

  // Cast to EnvironmentPreviewGroup for type-safe access
  const displayData = $derived(
    (stream.data as EnvironmentPreviewGroup | null) ?? initialEnvironment
  )

  // Determine display type: PR environments show PR-style, named envs show branch-style
  const isPrEnvironment = $derived(displayData?.environmentKind === "transient")
  const displayType = $derived(isPrEnvironment ? "pr" : "env")

  // Identifier for the page - PR number for transient, environment name for named
  const identifier = $derived(
    isPrEnvironment && displayData?.prNumber
      ? displayData.prNumber
      : displayData?.environmentName ?? environmentName
  )

  // Get the latest run group's SHA for the "new run" badge
  const latestRunGroupSha = $derived(
    displayData ? getLatestRunGroup(displayData)?.headSha ?? null : null
  )

  // GitHub URL - PR link for transient, repo link for named
  const githubUrl = $derived(
    isPrEnvironment && displayData?.prNumber
      ? githubPullUrl({ org, repo: displayData?.repo ?? repo }, displayData.prNumber)
      : githubRepoUrl({ org, repo: displayData?.repo ?? repo })
  )

  // Page title
  const pageTitle = $derived(
    isPrEnvironment && displayData?.prNumber
      ? `PR #${displayData.prNumber} - ${repo} - Yaffle`
      : `${environmentName} - ${repo} - Yaffle`
  )

  let canManageConnections = $state(false)
  let canMutateInfrastructure = $state(false)
  let lastEnvironmentConnectionState = $state<"connecting" | "connected" | "disconnected">("connecting")
  let hasSeenEnvironmentConnected = $state(false)
  let environmentReconnectCount = $state(0)
  let lastEnvironmentSnapshotMetaKey = $state<string | null>(null)
  let hasReportedNoDataFlash = $state(false)

  $effect(() => {
    initialEnvironment = data.initialEnvironment
  })

  $effect(() => {
    const runGroupId = requestedRunGroupId
    const runGroups = displayData?.runGroups ?? []
    if (!runGroupId) {
      return
    }

    const exists = runGroups.some((runGroup) => runGroup.id === runGroupId)
    if (!exists || stream.viewedRunGroupId === runGroupId) {
      return
    }

    stream.pinToRunGroup(runGroupId)
  })

  function shouldIgnoreVisibilityReconnect(): boolean {
    if (!browser) {
      return true
    }

    if (document.hidden) {
      return true
    }

    return lastVisibleAtMs != null && performance.now() - lastVisibleAtMs < 1_000
  }

  $effect(() => {
    const connectionState = stream.connectionState

    if (connectionState === "connected") {
      if (
        hasSeenEnvironmentConnected
        && lastEnvironmentConnectionState === "disconnected"
        && !shouldIgnoreVisibilityReconnect()
      ) {
        environmentReconnectCount += 1
        trackRunViewEvent({
          name: "run_view_env_stream_reconnected",
          streamType: "environment",
          reconnectCount: environmentReconnectCount,
          connectionState,
          isVisible: !document.hidden,
        })
      }

      hasSeenEnvironmentConnected = true
    }

    lastEnvironmentConnectionState = connectionState
  })

  $effect(() => {
    const meta = stream.latestMeta
    const latestRunGroupId = displayData ? getLatestRunGroup(displayData)?.id ?? null : null
    const workspaceCount = displayData?.workspaces.length

    if (!meta || !displayData) {
      return
    }

    const metaKey = `${meta.streamId}:${meta.sentAt}`
    if (metaKey === lastEnvironmentSnapshotMetaKey) {
      return
    }

    lastEnvironmentSnapshotMetaKey = metaKey

    const sourceEventMs = Date.parse(meta.sourceEventAt)
    const sentAtMs = Date.parse(meta.sentAt)
    const now = Date.now()

    trackRunViewEvent({
      name: "run_view_env_snapshot_applied",
      streamType: "environment",
      runGroupId: latestRunGroupId,
      workspaceCount,
      sourceEventType: meta.sourceEventType,
      sourceEventAt: meta.sourceEventAt,
      sentAt: meta.sentAt,
      freshnessMs: Number.isFinite(sourceEventMs) ? now - sourceEventMs : undefined,
      transportMs: Number.isFinite(sourceEventMs) && Number.isFinite(sentAtMs)
        ? sentAtMs - sourceEventMs
        : undefined,
      clientApplyMs: Number.isFinite(sentAtMs) ? now - sentAtMs : undefined,
      isVisible: !document.hidden,
    })
  })

  $effect(() => {
    if (
      hasReportedNoDataFlash
      || displayData
      || stream.connectionState === "connecting"
    ) {
      return
    }

    trackRunViewEvent({
      name: "run_view_no_data_flash",
      surface: "page",
      connectionState: stream.connectionState,
      isVisible: typeof document !== "undefined" ? !document.hidden : undefined,
    })

    hasReportedNoDataFlash = true
  })

  onMount(() => {
    if (!browser) {
      return
    }

    let longTaskObserver: PerformanceObserver | null = null

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        lastVisibleAtMs = performance.now()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    if (
      typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ) {
      longTaskObserver = new PerformanceObserver((list) => {
        const latestRunGroupId = displayData ? getLatestRunGroup(displayData)?.id ?? null : null
        const workspaceCount = displayData?.workspaces.length

        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_THRESHOLD_MS) {
            continue
          }

          trackRunViewEvent({
            name: "run_view_long_task",
            runGroupId: latestRunGroupId,
            durationMs: entry.duration,
            workspaceCount,
            connectionState: stream.connectionState,
            isVisible: !document.hidden,
          })
        }
      })

      longTaskObserver.observe({ entryTypes: ["longtask"] })
    }

    trackRunViewEvent({
      name: "run_view_opened",
    })

    void (async () => {
      try {
        const orgsRes = await listOrgs()
        const orgRole = orgsRes.data.find((item) => item.slug === org)?.role ?? ""
        canManageConnections = orgRole === "admin"
        canMutateInfrastructure = roleCanMutateInfrastructure(orgRole)
      } catch {
        canManageConnections = false
        canMutateInfrastructure = false
      }
    })()

    return () => {
      longTaskObserver?.disconnect()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  })
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

{#if stream.connectionState === "connecting" && !displayData}
  <AsyncLoader
    variant="page"
    title="Loading environment"
    message="Connecting to live run updates and dependency graph data."
  />
{:else if displayData}
  <PreviewGroupPage
    type={displayType}
    {org}
    repo={displayData.repo}
    {identifier}
    ref={displayData.ref}
    headSha={stream.pinnedHeadSha ?? displayData.headSha}
    authorLogin={displayData.authorLogin}
    environmentPolicy={displayData.environmentPolicy}
    environmentLifecycle={displayData.environmentLifecycle}
    workspaces={displayData.workspaces}
    runGroups={displayData.runGroups}
    {githubUrl}
    streaming={stream.isStreaming}
    viewedRunGroupId={stream.viewedRunGroupId}
    hasNewerRunGroup={stream.hasNewerRunGroup}
    latestHeadSha={latestRunGroupSha}
    onSwitchToLatest={stream.switchToLatest}
    onSelectRunGroup={stream.pinToRunGroup}
    {canManageConnections}
    {canMutateInfrastructure}
    {runViewStartMs}
    runViewCorrelation={{ runViewSessionId, pageViewId }}
    onTrackRunViewEvent={trackRunViewEvent}
  />
{:else}
  <div class="flex items-center justify-center h-full text-text-dim">
    No preview data found for this environment.
  </div>
{/if}
