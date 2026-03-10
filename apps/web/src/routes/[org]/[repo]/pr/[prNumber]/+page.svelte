<script lang="ts">
  import { page } from "$app/stores"
  import { usePreviewStream } from "$lib/sse/index.svelte"
  import { getLatestRunGroup } from "$lib/sse/types"
  import type { PrPreviewGroup } from "$lib/api"
  import PreviewGroupPage from "$lib/components/PreviewGroupPage.svelte"

  // Reactive params
  const org = $derived($page.params.org ?? "")
  const repo = $derived($page.params.repo ?? "")
  const prNumber = $derived(Number($page.params.prNumber) || 0)

  // Single hook replaces all inline SSE code
  const stream = usePreviewStream(() => org, () => repo, "pr", () => prNumber)

  // Cast to PrPreviewGroup for type-safe access to prNumber/authorLogin
  const displayData = $derived(stream.data as PrPreviewGroup | null)

  // Get the latest run group's SHA for the "new run" badge
  const latestRunGroupSha = $derived(
    displayData ? getLatestRunGroup(displayData)?.headSha ?? null : null
  )

  // GitHub URL for PR
  const githubUrl = $derived(
    displayData
      ? `https://github.com/${displayData.repo}/pull/${displayData.prNumber}`
      : `https://github.com/${repo}/pull/${prNumber}`,
  )
</script>

<svelte:head>
  <title>PR #{prNumber} - {repo} - Yaffle</title>
</svelte:head>

{#if stream.connectionState === "connecting" && !displayData}
  <div class="flex items-center justify-center h-full text-text-muted">
    Loading...
  </div>
{:else if displayData}
  <PreviewGroupPage
    type="pr"
    {org}
    repo={displayData.repo}
    identifier={displayData.prNumber}
    branch={displayData.branch}
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
  />
{:else}
  <div class="flex items-center justify-center h-full text-text-dim">
    No preview data found for this PR.
  </div>
{/if}
