<script lang="ts">
  import { page } from "$app/stores"
  import { usePreviewStream } from "$lib/sse/index.svelte"
  import type { EnvPreviewGroup } from "$lib/api"
  import PreviewGroupPage from "$lib/components/PreviewGroupPage.svelte"

  // Reactive params
  const org = $derived($page.params.org ?? "")
  const repo = $derived($page.params.repo ?? "")
  const branch = $derived($page.params.branch ?? "")

  // Single hook replaces all inline SSE code
  const stream = usePreviewStream(() => org, () => repo, "env", () => branch)

  // Cast to EnvPreviewGroup for type-safe access
  const displayData = $derived(stream.data as EnvPreviewGroup | null)

  // GitHub URL for repo
  const githubUrl = $derived(
    displayData
      ? `https://github.com/${displayData.repo}`
      : `https://github.com/${repo}`,
  )
</script>

<svelte:head>
  <title>{branch} - {repo} - Yaffle</title>
</svelte:head>

{#if stream.connectionState === "connecting" && !displayData}
  <div class="flex items-center justify-center h-full text-text-muted">
    Loading...
  </div>
{:else if displayData}
  <PreviewGroupPage
    type="env"
    {org}
    repo={displayData.repo}
    identifier={displayData.branch}
    branch={displayData.branch}
    headSha={stream.pinnedHeadSha ?? displayData.headSha}
    workspaces={displayData.workspaces}
    {githubUrl}
    streaming={stream.isStreaming}
    viewedRunId={stream.viewedRunId}
    hasNewerRun={stream.hasNewerRun}
    latestHeadSha={displayData.headSha}
    onSwitchToLatest={stream.switchToLatest}
  />
{:else}
  <div class="flex items-center justify-center h-full text-text-dim">
    No preview data found for this environment.
  </div>
{/if}
