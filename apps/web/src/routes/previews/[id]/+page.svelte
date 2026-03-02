<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/stores"
  import { onDestroy, onMount } from "svelte"
  import { getPreview, getPreviewRuns, getPreviewOutputs, type Preview, type Run } from "$lib/api"
  import { statusConfig, formatDuration, formatRelativeTime, shortSha } from "$lib/status"

  let preview = $state<Preview | null>(null)
  let runs = $state<Run[]>([])
  let outputs = $state<Record<string, unknown> | null>(null)
  let loading = $state(true)
  let error = $state("")
  let currentId = ""
  let stream: EventSource | null = null

  $effect(() => {
    const id = $page.params.id ?? ""
    if (!id) return
    currentId = id
    loadPreview(id)
    connectStream(id)
  })

  onMount(() => {
    if (!browser) return
    if (currentId) connectStream(currentId)
  })

  onDestroy(() => {
    if (stream) stream.close()
  })

  function connectStream(id: string) {
    if (!browser) return
    if (stream) stream.close()
    stream = new EventSource(`/api/previews/${id}/stream`)
    stream.addEventListener("update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          preview: Preview | null
          runs: Run[]
          outputs: Record<string, unknown> | null
        }
        preview = payload.preview
        runs = payload.runs
        outputs = payload.outputs
      } catch {
        // ignore malformed payloads
      }
    })
  }

  async function loadPreview(id: string) {
    loading = true
    error = ""
    try {
      const [previewRes, runsRes] = await Promise.all([
        getPreview(id),
        getPreviewRuns(id),
      ])
      preview = previewRes.data
      runs = runsRes.data

      // Try to get outputs (may 404 if no successful apply)
      try {
        const outputsRes = await getPreviewOutputs(id)
        outputs = outputsRes.data as Record<string, unknown>
      } catch {
        outputs = null
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }
</script>

{#if loading}
  <div class="text-text-muted text-sm">Loading...</div>
{:else if error}
  <div class="bg-red-950/50 border border-red-800 rounded px-4 py-3 text-sm text-red-300">
    {error}
  </div>
{:else if preview}
  {@const cfg = statusConfig(preview.status)}
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-3 mb-1">
          <h1 class="text-xl font-semibold">{preview.repo}</h1>
          <span class="font-mono text-sm text-text-muted">#{preview.prNumber}</span>
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
            <span class="font-mono">{cfg.icon}</span>
            {cfg.label}
          </span>
        </div>
        <div class="flex gap-4 text-sm text-text-muted">
          <span>
            <code class="text-xs bg-surface-overlay px-1.5 py-0.5 rounded">{preview.workspacePath}</code>
          </span>
          <span>{preview.branch}</span>
          <span>
            <code class="font-mono text-xs text-text-dim">{shortSha(preview.headSha)}</code>
          </span>
          {#if preview.authorLogin}
            <span class="text-text-dim">@{preview.authorLogin}</span>
          {/if}
        </div>
      </div>
      <a href="/" class="text-sm text-text-muted hover:text-text transition-colors">&larr; Back</a>
    </div>

    <!-- Run history -->
    <section>
      <h2 class="text-sm font-medium text-text-muted mb-3">Runs</h2>
      {#if runs.length === 0}
        <div class="text-text-dim text-sm py-4 text-center">No runs yet.</div>
      {:else}
        <div class="border border-border rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-surface-raised text-text-muted text-left">
                <th class="px-4 py-2 font-medium">Type</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Summary</th>
                <th class="px-4 py-2 font-medium">Duration</th>
                <th class="px-4 py-2 font-medium text-right">When</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border-subtle">
              {#each runs as run (run.id)}
                {@const runCfg = statusConfig(run.status === "success" ? "ready" : run.status === "running" ? "applying" : run.status)}
                <tr class="hover:bg-surface-raised/50 transition-colors">
                  <td class="px-4 py-2.5">
                    <a href="/runs/{run.id}" class="font-mono text-xs text-yaffle-400 hover:underline">
                      {run.runType}
                    </a>
                  </td>
                  <td class="px-4 py-2.5">
                    <span class="flex items-center gap-1.5 {runCfg.color}">
                      <span class="font-mono text-xs">{runCfg.icon}</span>
                      <span class="text-xs">{run.status}</span>
                    </span>
                  </td>
                  <td class="px-4 py-2.5 text-text-muted text-xs font-mono">
                    {#if run.errorMessage}
                      <span class="text-status-failed">{run.errorMessage.slice(0, 80)}</span>
                    {:else if run.planSummary}
                      {run.planSummary}
                    {:else}
                      -
                    {/if}
                  </td>
                  <td class="px-4 py-2.5 text-text-dim text-xs font-mono">
                    {formatDuration(run.durationMs)}
                  </td>
                  <td class="px-4 py-2.5 text-right text-text-dim text-xs">
                    {formatRelativeTime(run.createdAt)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- Outputs -->
    {#if outputs}
      <section>
        <h2 class="text-sm font-medium text-text-muted mb-3">Outputs</h2>
        <div class="border border-border rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-surface-raised text-text-muted text-left">
                <th class="px-4 py-2 font-medium">Output</th>
                <th class="px-4 py-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border-subtle">
              {#each Object.entries(outputs) as [key, val] (key)}
                <tr>
                  <td class="px-4 py-2.5 font-mono text-xs text-yaffle-400">{key}</td>
                  <td class="px-4 py-2.5 font-mono text-xs text-text-muted">
                    {typeof val === "object" && val !== null && "value" in val
                      ? String((val as Record<string, unknown>).value)
                      : JSON.stringify(val)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
  </div>
{/if}
