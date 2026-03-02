<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/stores"
  import { onDestroy, onMount } from "svelte"
  import {
    approvePreview,
    getPreview,
    getPreviewOutputs,
    getPreviewRuns,
    type Preview,
    type Run,
  } from "$lib/api"
  import { statusConfig, formatDuration, formatRelativeTime, shortSha } from "$lib/status"

  let preview = $state<Preview | null>(null)
  let runs = $state<Run[]>([])
  let outputs = $state<Record<string, unknown> | null>(null)
  let loading = $state(true)
  let error = $state("")
  let approveError = $state("")
  let approverLogin = $state("")
  let approverId = $state("")
  let authOrg = $state("")
  let authRole = $state("approver")
  let hasToken = $state(false)
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
    approverLogin = localStorage.getItem("yaffle.authLogin") ?? approverLogin
    approverId = localStorage.getItem("yaffle.authUserId") ?? approverId
    authOrg = localStorage.getItem("yaffle.authOrg") ?? authOrg
    authRole = localStorage.getItem("yaffle.authRole") ?? authRole
    hasToken = Boolean(localStorage.getItem("yaffle.accessToken"))
    if (currentId) connectStream(currentId)
  })

  $effect(() => {
    if (typeof localStorage === "undefined") return
    localStorage.setItem("yaffle.authLogin", approverLogin)
    localStorage.setItem("yaffle.authUserId", approverId)
    localStorage.setItem("yaffle.authOrg", authOrg)
    localStorage.setItem("yaffle.authRole", authRole)
  })

  onDestroy(() => {
    if (stream) stream.close()
  })

  function connectStream(id: string) {
    if (!browser) return
    if (stream) stream.close()
    const token = localStorage.getItem("yaffle.accessToken")
    const params = token ? `?token=${encodeURIComponent(token)}` : ""
    stream = new EventSource(`/api/previews/${id}/stream${params}`)
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

  async function approve() {
    if (!preview) return
    approveError = ""
    if (hasToken) {
      try {
        await approvePreview(preview.id)
        await loadPreview(preview.id)
      } catch (e) {
        approveError = e instanceof Error ? e.message : String(e)
      }
      return
    }
    const login = approverLogin.trim()
    const idStr = approverId.trim()
    if (!login || !idStr) {
      approveError = "Set approver login and user id"
      return
    }
    const userId = Number(idStr)
    if (!Number.isFinite(userId)) {
      approveError = "Invalid user id"
      return
    }
    try {
      await approvePreview(preview.id, login, userId)
      await loadPreview(preview.id)
    } catch (e) {
      approveError = e instanceof Error ? e.message : String(e)
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
      {#if preview.requireApproval && preview.status === "awaiting_approval"}
        <section class="border border-yaffle-500/40 bg-surface-raised rounded-lg p-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium">Approval required</div>
              <div class="text-xs text-text-muted mt-1">
                This production apply is waiting for approval.
              </div>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-1 gap-3">
            {#if hasToken}
              <div class="flex items-center gap-3">
                <button
                  class="px-3 py-1.5 rounded bg-yaffle-600 text-white text-sm hover:bg-yaffle-500 transition-colors"
                  onclick={approve}
                >
                  Approve & apply
                </button>
              </div>
            {:else}
              <div class="text-xs text-text-muted">
                Sign in to approve, or use dev headers below.
              </div>
              <div class="flex gap-3 flex-wrap">
                <input
                  type="text"
                  bind:value={authOrg}
                  placeholder="org login"
                  class="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text
                         placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-40"
                />
                <input
                  type="text"
                  bind:value={authRole}
                  placeholder="role (approver)"
                  class="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text
                         placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-40"
                />
                <input
                  type="text"
                  bind:value={approverLogin}
                  placeholder="approver login"
                  class="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text
                         placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-48"
                />
                <input
                  type="text"
                  bind:value={approverId}
                  placeholder="approver user id"
                  class="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text
                         placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-48"
                />
                <button
                  class="px-3 py-1.5 rounded bg-yaffle-600 text-white text-sm hover:bg-yaffle-500 transition-colors"
                  onclick={approve}
                >
                  Approve & apply
                </button>
              </div>
            {/if}
            {#if approveError}
              <div class="text-xs text-status-failed">{approveError}</div>
            {/if}
          </div>
        </section>
      {/if}
    <!-- Header -->
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-3 mb-1">
          <h1 class="text-xl font-semibold">{preview.repo}</h1>
          {#if preview.prNumber > 0}
            <span class="font-mono text-sm text-text-muted">#{preview.prNumber}</span>
          {/if}
          {#if preview.status !== "ready"}
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium {cfg.color} bg-surface-overlay">
              <span class="font-mono">{cfg.icon}</span>
              {cfg.label}
            </span>
          {/if}
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
