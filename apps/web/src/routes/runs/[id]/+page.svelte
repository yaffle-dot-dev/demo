<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/stores"
  import { onDestroy, onMount } from "svelte"
  import { getRun, getRunPlan, getRunOutput, type Run } from "$lib/api"
  import { statusConfig, formatDuration, formatRelativeTime } from "$lib/status"

  let run = $state<Run | null>(null)
  let planJson = $state<unknown>(null)
  let rawOutput = $state("")
  let loading = $state(true)
  let error = $state("")
  let activeTab = $state<"plan" | "output">("plan")
  let currentId = ""
  let stream: EventSource | null = null
  let autoScroll = $state(true)

  $effect(() => {
    const id = $page.params.id ?? ""
    if (!id) return
    currentId = id
    loadRun(id)
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
    stream = new EventSource(`/api/runs/${id}/stream`)
    stream.addEventListener("update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          run: Run | null
          planJson: unknown
          output: string
        }
        run = payload.run
        planJson = payload.planJson
        rawOutput = payload.output
        if (autoScroll) {
          queueMicrotask(() => {
            const el = document.getElementById("live-output")
            if (el) el.scrollTop = el.scrollHeight
          })
        }
      } catch {
        // ignore malformed payloads
      }
    })
  }

  async function loadRun(id: string) {
    loading = true
    error = ""
    try {
      const runRes = await getRun(id)
      run = runRes.data

      // Load plan and output in parallel
      const [planRes, outputRes] = await Promise.allSettled([
        getRunPlan(id),
        getRunOutput(id),
      ])

      planJson = planRes.status === "fulfilled" ? planRes.value.data : null
      rawOutput = outputRes.status === "fulfilled" ? outputRes.value : ""
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  interface ResourceChange {
    address: string
    change: { actions: string[] }
    type?: string
  }

  function planChanges(plan: unknown): ResourceChange[] {
    if (!plan || typeof plan !== "object") return []
    const p = plan as Record<string, unknown>
    if (!Array.isArray(p.resource_changes)) return []
    return p.resource_changes as ResourceChange[]
  }

  function actionColor(actions: string[]): string {
    if (actions.includes("delete")) return "text-status-failed"
    if (actions.includes("create")) return "text-status-ready"
    if (actions.includes("update")) return "text-status-planning"
    return "text-text-muted"
  }

  function actionLabel(actions: string[]): string {
    if (actions.includes("create") && actions.includes("delete")) return "replace"
    if (actions.includes("create")) return "create"
    if (actions.includes("delete")) return "destroy"
    if (actions.includes("update")) return "update"
    if (actions.includes("read")) return "read"
    return actions.join(", ")
  }

  function actionIcon(actions: string[]): string {
    if (actions.includes("create") && actions.includes("delete")) return "~"
    if (actions.includes("create")) return "+"
    if (actions.includes("delete")) return "-"
    if (actions.includes("update")) return "~"
    return " "
  }
</script>

{#if loading}
  <div class="text-text-muted text-sm">Loading...</div>
{:else if error}
  <div class="bg-red-950/50 border border-red-800 rounded px-4 py-3 text-sm text-red-300">
    {error}
  </div>
{:else if run}
  {@const cfg = statusConfig(run.status === "success" ? "ready" : run.status === "running" ? "applying" : run.status)}
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-3 mb-1">
          <h1 class="text-xl font-semibold font-mono">{run.runType}</h1>
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
            <span class="font-mono">{cfg.icon}</span>
            {run.status}
          </span>
        </div>
        <div class="flex gap-4 text-sm text-text-muted">
          <span>Duration: <span class="font-mono text-xs">{formatDuration(run.durationMs)}</span></span>
          <span>{formatRelativeTime(run.createdAt)}</span>
          {#if run.checkRunId}
            <span class="text-text-dim">Check run #{run.checkRunId}</span>
          {/if}
        </div>
      </div>
      <a href="/previews/{run.previewId}" class="text-sm text-text-muted hover:text-text transition-colors">
        &larr; Back to preview
      </a>
    </div>

    <!-- Error -->
    {#if run.errorMessage}
      <div class="bg-red-950/50 border border-red-800 rounded px-4 py-3 text-sm text-red-300 font-mono whitespace-pre-wrap">
        {run.errorMessage}
      </div>
    {/if}

    <!-- Plan summary -->
    {#if run.planSummary}
      <div class="bg-surface-raised border border-border rounded px-4 py-2 text-sm font-mono text-text-muted">
        {run.planSummary}
      </div>
    {/if}

    <!-- Tabs -->
    <div class="border-b border-border flex gap-4">
      <button
        class="pb-2 text-sm font-medium transition-colors border-b-2 -mb-px
               {activeTab === 'plan' ? 'border-yaffle-500 text-text' : 'border-transparent text-text-muted hover:text-text'}"
        onclick={() => activeTab = "plan"}
      >
        Plan
      </button>
      <button
        class="pb-2 text-sm font-medium transition-colors border-b-2 -mb-px
               {activeTab === 'output' ? 'border-yaffle-500 text-text' : 'border-transparent text-text-muted hover:text-text'}"
        onclick={() => activeTab = "output"}
      >
        Live output
      </button>
    </div>

    <!-- Tab content -->
    {#if activeTab === "plan"}
      {#if planJson}
        {@const changes = planChanges(planJson)}
        {#if changes.length === 0}
          <div class="text-text-dim text-sm py-4 text-center">No resource changes.</div>
        {:else}
          <div class="border border-border rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-surface-raised text-text-muted text-left">
                  <th class="px-4 py-2 font-medium w-8"></th>
                  <th class="px-4 py-2 font-medium">Resource</th>
                  <th class="px-4 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border-subtle">
                {#each changes as change (change.address)}
                  {@const actions = change.change?.actions ?? []}
                  <tr class="hover:bg-surface-raised/50 transition-colors">
                    <td class="px-4 py-2 font-mono text-xs {actionColor(actions)} text-center">
                      {actionIcon(actions)}
                    </td>
                    <td class="px-4 py-2 font-mono text-xs text-text">
                      {change.address}
                    </td>
                    <td class="px-4 py-2 text-xs {actionColor(actions)}">
                      {actionLabel(actions)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {:else}
        <div class="text-text-dim text-sm py-4 text-center">No plan data available.</div>
      {/if}
    {:else}
      <div class="flex items-center justify-between text-xs text-text-dim">
        <span>Streaming latest output</span>
        <label class="flex items-center gap-2">
          <input type="checkbox" bind:checked={autoScroll} />
          Auto-scroll
        </label>
      </div>
      <!-- Raw output -->
      <div
        id="live-output"
        class="bg-surface-raised border border-border rounded-lg p-4 font-mono text-xs text-text-muted whitespace-pre-wrap overflow-x-auto max-h-[600px] overflow-y-auto"
      >
        {rawOutput || "No output available yet."}
      </div>
    {/if}
  </div>
{/if}
