<script lang="ts">
  import type { ResourceSpan } from "$lib/api"
  import { getRunSpans, getRunPlan } from "$lib/api"

  interface Props {
    /** Spans from SSE (live, for the currently running run) */
    liveSpans?: ResourceSpan[]
    /** Completed run IDs to always lazy-load spans for */
    completedRunIds?: string[]
    /** Plan run ID (to fetch plan JSON for per-resource action coloring) */
    planRunId?: string | null
    /** Whether a run is still streaming */
    streaming?: boolean
  }

  let props: Props = $props()

  const streaming = $derived(props.streaming ?? false)

  // Lazy-loaded spans for completed runs
  let loadedSpans = $state<ResourceSpan[]>([])
  let loadedKey: string = ""
  let loading = $state(false)

  $effect(() => {
    const ids = props.completedRunIds ?? []
    const key = ids.join(",")
    if (ids.length > 0 && key !== loadedKey) {
      loading = true
      loadedKey = key
      Promise.all(ids.map((id) => getRunSpans(id).then((r) => r.data)))
        .then((results) => {
          loadedSpans = results.flat()
        })
        .catch(() => {
          loadedSpans = []
        })
        .finally(() => {
          loading = false
        })
    }
  })

  // Fetch plan JSON to determine per-resource planned actions
  // This lets us color plan refresh bars as soon as the plan completes
  let planActions = $state<Map<string, string>>(new Map())
  let planLoadedId: string | null = null

  $effect(() => {
    const planId = props.planRunId
    if (planId && planId !== planLoadedId) {
      planLoadedId = planId
      getRunPlan(planId)
        .then((res) => {
          const plan = res.data as { resource_changes?: Array<{ address: string; change?: { actions?: string[] } }> } | null
          const map = new Map<string, string>()
          for (const rc of plan?.resource_changes ?? []) {
            const actions = rc.change?.actions ?? []
            if (actions.includes("create") && actions.includes("delete")) {
              map.set(rc.address, "update") // replace → treat as update
            } else if (actions.includes("create")) {
              map.set(rc.address, "create")
            } else if (actions.includes("delete")) {
              map.set(rc.address, "delete")
            } else if (actions.includes("update")) {
              map.set(rc.address, "update")
            }
            // no-op / read → don't add (stays gray)
          }
          planActions = map
        })
        .catch(() => {
          planActions = new Map()
        })
    }
  })

  // Merge: completed run spans (lazy-loaded) + live SSE spans (for running run)
  // Deduplicate by span ID in case SSE delivers spans that were also lazy-loaded
  const allSpans = $derived.by((): ResourceSpan[] => {
    const live = props.liveSpans ?? []
    if (loadedSpans.length === 0) return live
    if (live.length === 0) return loadedSpans

    const seen = new Set(loadedSpans.map((s) => s.id))
    const merged = [...loadedSpans]
    for (const s of live) {
      if (!seen.has(s.id)) {
        merged.push(s)
      }
    }
    return merged
  })

  // Now ticker for live mode — 500ms interval
  let now = $state(Date.now())

  $effect(() => {
    if (streaming && allSpans.some((s) => s.status === "started")) {
      const id = setInterval(() => {
        now = Date.now()
      }, 500)
      return () => clearInterval(id)
    }
  })

  // Layout constants
  const ROW_HEIGHT = 28

  // Group spans by resource address, preserving order of first appearance
  interface ResourceRow {
    address: string
    spans: ResourceSpan[]
  }

  const groupedRows = $derived.by((): ResourceRow[] => {
    const order: string[] = []
    const map = new Map<string, ResourceSpan[]>()

    const sorted = [...allSpans].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    )

    for (const span of sorted) {
      const addr = span.resourceAddress
      if (!map.has(addr)) {
        order.push(addr)
        map.set(addr, [])
      }
      map.get(addr)!.push(span)
    }

    return order.map((address) => ({ address, spans: map.get(address)! }))
  })

  // Compute time range across ALL spans
  const timeRange = $derived.by(() => {
    if (allSpans.length === 0) return { start: 0, end: 1000, duration: 1000 }

    let start = Infinity
    let end = -Infinity

    for (const s of allSpans) {
      const st = new Date(s.startedAt).getTime()
      start = Math.min(start, st)

      if (s.completedAt) {
        end = Math.max(end, new Date(s.completedAt).getTime())
      } else if (streaming) {
        end = Math.max(end, now)
      } else {
        end = Math.max(end, st + (s.durationMs ?? 1000))
      }
    }

    if (end <= start) end = start + 1000
    return { start, end, duration: end - start }
  })

  function formatTickLabel(ms: number): string {
    const secs = Math.round(ms / 1000)
    if (secs < 60) return `${secs}s`
    return `${Math.floor(secs / 60)}m${secs % 60 ? `${secs % 60}s` : ""}`
  }

  const ticks = $derived.by(() => {
    const { duration } = timeRange
    let interval: number
    if (duration < 30_000) interval = 5_000
    else if (duration < 120_000) interval = 10_000
    else if (duration < 300_000) interval = 30_000
    else interval = 60_000

    const result: { ms: number; label: string }[] = []
    let t = 0
    while (t <= duration) {
      result.push({ ms: t, label: formatTickLabel(t) })
      t += interval
    }

    const last = result[result.length - 1]
    if (!last || last.ms < duration) {
      // Drop the last regular tick if it's too close to the duration tick (within half an interval)
      if (last && (duration - last.ms) < interval * 0.5) {
        result.pop()
      }
      result.push({ ms: duration, label: formatTickLabel(duration) })
    }

    return result
  })

  // For each resource, find the planned action from:
  // 1. Plan JSON (available as soon as plan completes — best source)
  // 2. Apply-phase spans (fallback if plan JSON not loaded yet)
  const applyActionByAddress = $derived.by((): Map<string, string> => {
    const map = new Map<string, string>()
    for (const span of allSpans) {
      if (span.action !== "refresh" && span.action !== "read") {
        map.set(span.resourceAddress, span.action)
      }
    }
    return map
  })

  // Resolve effective action for coloring:
  // - apply spans use their own action directly
  // - plan refresh/read spans check plan JSON first, then apply spans, then stay gray
  function effectiveAction(span: ResourceSpan): string {
    if (span.action !== "refresh" && span.action !== "read") return span.action
    return planActions.get(span.resourceAddress)
      ?? applyActionByAddress.get(span.resourceAddress)
      ?? span.action
  }

  function actionColor(action: string): string {
    switch (action) {
      case "create": return "var(--color-status-ready)"
      case "update": return "#c49a2a"
      case "delete": return "var(--color-status-failed)"
      default: return "var(--color-text-dim)"
    }
  }

  function barColor(span: ResourceSpan): string {
    return actionColor(effectiveAction(span))
  }

  function barOpacity(span: ResourceSpan): number {
    if (span.status === "started") return 0.5
    const eff = effectiveAction(span)
    // Plan refresh bars with no apply action = no change = dim
    if (eff === "refresh" || eff === "read") return 0.4
    // Plan refresh bars colored by known outcome = slightly faded
    if ((span.action === "refresh" || span.action === "read") && eff !== span.action) return 0.55
    return 0.85
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const secs = Math.round(ms / 1000)
    if (secs < 60) return `${secs}s`
    return `${Math.floor(secs / 60)}m${secs % 60}s`
  }

  function spanStartMs(span: ResourceSpan): number {
    return new Date(span.startedAt).getTime() - timeRange.start
  }

  function spanEndMs(span: ResourceSpan): number {
    const startMs = spanStartMs(span)
    if (span.completedAt) return new Date(span.completedAt).getTime() - timeRange.start
    if (span.status === "started" && streaming) return now - timeRange.start
    return startMs + (span.durationMs ?? 1000)
  }
</script>

{#if loading && allSpans.length === 0}
  <div class="flex items-center justify-center h-32 text-text-dim text-sm">
    Loading timeline...
  </div>
{:else if allSpans.length === 0}
  <div class="flex flex-col items-center justify-center h-32 text-center">
    <p class="text-sm text-text-muted">No resource spans</p>
    <p class="text-xs text-text-dim/75 mt-1">Resource timing data will appear here during plan and apply operations.</p>
  </div>
{:else}
  <div class="resource-timeline">
    {#if streaming && allSpans.some((s) => s.status === "started")}
      <div class="flex items-center gap-1.5 px-3 py-1 text-[10px] text-status-planning">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-status-planning animate-pulse"></span>
        live
      </div>
    {/if}

    <!-- Time axis at top -->
    <div class="time-axis time-axis-top">
      <div class="resource-label"></div>
      <div class="resource-bar-cell">
        {#each ticks as tick, i}
          {@const pct = (tick.ms / timeRange.duration) * 100}
          {@const isLast = i === ticks.length - 1}
          {#if pct <= 100}
            <span
              class="time-tick font-mono text-[10px] text-text-dim"
              style="{isLast ? `right: 0` : `left: ${pct}%`}"
            >
              {tick.label}
            </span>
          {/if}
        {/each}
      </div>
    </div>

    <!-- Resource rows (one per unique resource, multiple bars for plan + apply) -->
    {#each groupedRows as row (row.address)}
      <div class="resource-row">
        <div
          class="resource-label"
          title={row.address}
        >
          <span class="font-mono text-[11px] text-text-muted truncate">
            {row.address}
          </span>
        </div>
        <div class="resource-bar-cell">
          {#each row.spans as span (span.id)}
            {#if true}
              {@const startMs = spanStartMs(span)}
              {@const endMs = spanEndMs(span)}
              {@const durationMs = endMs - startMs}
              {@const leftPct = (startMs / timeRange.duration) * 100}
              {@const widthPct = Math.max(0.2, ((endMs - startMs) / timeRange.duration) * 100)}
              <div
                class="resource-bar"
                style="left: {leftPct}%; width: {widthPct}%;"
                title="{span.action} — {formatDuration(durationMs)}"
              >
                <div
                  class="resource-bar-fill"
                  class:resource-bar-pulse={span.status === "started"}
                  style="background: {barColor(span)}; opacity: {barOpacity(span)};"
                ></div>
                <span class="resource-bar-duration font-mono text-[10px] text-text-dim">
                  {formatDuration(durationMs)}
                </span>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/each}

    <!-- Time axis at bottom -->
    <div class="time-axis">
      <div class="resource-label"></div>
      <div class="resource-bar-cell">
        {#each ticks as tick, i}
          {@const pct = (tick.ms / timeRange.duration) * 100}
          {@const isLast = i === ticks.length - 1}
          {#if pct <= 100}
            <span
              class="time-tick font-mono text-[10px] text-text-dim"
              style="{isLast ? `right: 0` : `left: ${pct}%`}"
            >
              {tick.label}
            </span>
          {/if}
        {/each}
      </div>
    </div>

    <!-- Legend -->
    <div class="flex items-center gap-4 px-3 py-2 text-[10px] text-text-dim">
      <div class="flex items-center gap-1"><span class="legend-swatch" style="background: var(--color-text-dim); opacity: 0.4"></span> no change</div>
      <div class="flex items-center gap-1"><span class="legend-swatch" style="background: var(--color-status-ready); opacity: 0.85"></span> create</div>
      <div class="flex items-center gap-1"><span class="legend-swatch" style="background: #c49a2a; opacity: 0.85"></span> update</div>
      <div class="flex items-center gap-1"><span class="legend-swatch" style="background: var(--color-status-failed); opacity: 0.85"></span> delete</div>
    </div>
  </div>
{/if}

<style>
  .resource-timeline {
    border-radius: 0.375rem;
  }

  .resource-row {
    display: flex;
    height: 28px;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);
  }

  .resource-label {
    width: 280px;
    min-width: 280px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0 0.75rem;
    overflow: hidden;
    border-right: 1px solid var(--color-border);
  }

  .resource-bar-cell {
    flex: 1;
    min-width: 0;
    position: relative;
    overflow: hidden;
  }

  .time-axis .resource-bar-cell {
    overflow: visible;
  }

  .resource-bar {
    position: absolute;
    top: 5px;
    height: 18px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .resource-bar-fill {
    height: 100%;
    min-width: 3px;
    border-radius: 3px;
    flex-shrink: 0;
    width: 100%;
  }

  .resource-bar-pulse {
    animation: pulse-opacity 2s ease-in-out infinite;
  }

  @keyframes pulse-opacity {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 0.7; }
  }

  .resource-bar-duration {
    white-space: nowrap;
    flex-shrink: 0;
  }

  .time-axis {
    display: flex;
    height: 20px;
  }

  .time-axis-top {
    border-bottom: 1px solid var(--color-border);
  }

  .time-axis:last-child {
    border-top: 1px solid var(--color-border);
  }

  .time-tick {
    position: absolute;
    top: 2px;
    transform: translateX(2px);
  }

  .legend-swatch {
    display: inline-block;
    width: 12px;
    height: 8px;
    border-radius: 2px;
  }
</style>
