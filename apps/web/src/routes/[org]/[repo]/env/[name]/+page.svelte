<script lang="ts">
  import { browser } from "$app/environment"
  import { onMount } from "svelte"
  import { page } from "$app/stores"
  import { usePreviewStream } from "$lib/sse/index.svelte"
  import { getLatestRunGroup } from "$lib/sse/types"
  import { githubRepoUrl, githubPullUrl } from "$lib/github"
  import { getEnvironment, listOrgs } from "$lib/api"
  import type { EnvironmentPreviewGroup } from "$lib/api"
  import AsyncLoader from "$lib/components/AsyncLoader.svelte"
  import PreviewGroupPage from "$lib/components/PreviewGroupPage.svelte"

  type PageData = {
    initialEnvironment: EnvironmentPreviewGroup | null
  }

  let { data }: { data: PageData } = $props()
  let initialEnvironment = $state<EnvironmentPreviewGroup | null>(null)

  // Reactive params
  const org = $derived($page.params.org ?? "")
  const repo = $derived($page.params.repo ?? "")
  const environmentName = $derived($page.params.name ?? "")

  // Single hook replaces all inline SSE code - uses unified "environment" endpoint
  const stream = usePreviewStream(() => org, () => repo, "environment", () => environmentName)

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

  $effect(() => {
    initialEnvironment = data.initialEnvironment
  })

  $effect(() => {
    if (!browser || !org || !repo || !environmentName || data.initialEnvironment) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        const response = await getEnvironment(org, repo, environmentName, { view: "dag" })
        if (!cancelled) {
          initialEnvironment = response.data
        }
      } catch {
        if (!cancelled) {
          initialEnvironment = null
        }
      }
    })()

    return () => {
      cancelled = true
    }
  })

  onMount(() => {
    if (!browser) {
      return
    }

    void (async () => {
      try {
        const orgsRes = await listOrgs()
        const orgRole = orgsRes.data.find((item) => item.slug === org)?.role ?? ""
        canManageConnections = orgRole === "admin"
      } catch {
        canManageConnections = false
      }
    })()
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
    workspaces={displayData.workspaces}
    runGroups={displayData.runGroups}
    {githubUrl}
    streaming={stream.isStreaming}
    viewedRunGroupId={stream.viewedRunGroupId}
    hasNewerRunGroup={stream.hasNewerRunGroup}
    latestHeadSha={latestRunGroupSha}
    onSwitchToLatest={stream.switchToLatest}
    {canManageConnections}
  />
{:else}
  <div class="flex items-center justify-center h-full text-text-dim">
    No preview data found for this environment.
  </div>
{/if}
