<script lang="ts">
  interface TerraformOutput {
    value: unknown
    type?: unknown
    sensitive?: boolean
  }

  interface Props {
    outputs: Record<string, TerraformOutput> | null
  }

  let props: Props = $props()

  const outputs = $derived(props.outputs)

  const STORAGE_KEY = "yaffle:outputs-view-format"
  let showJson = $state(typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "json")
  let revealedKeys = $state<Set<string>>(new Set())
  let copiedKey = $state<string | null>(null)
  let copiedJson = $state(false)

  function toggleReveal(key: string) {
    const next = new Set(revealedKeys)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    revealedKeys = next
  }

  function formatValue(value: unknown): string {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return JSON.stringify(value, null, 2)
  }

  function isMultiline(value: unknown): boolean {
    const formatted = formatValue(value)
    return formatted.includes("\n") || formatted.length > 80
  }

  async function copyValue(key: string, value: unknown) {
    try {
      await navigator.clipboard.writeText(formatValue(value))
      copiedKey = key
      setTimeout(() => {
        copiedKey = null
      }, 2000)
    } catch {
      // Clipboard API may not be available
    }
  }

  async function copyJson() {
    if (!outputs) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(outputs, null, 2))
      copiedJson = true
      setTimeout(() => {
        copiedJson = false
      }, 2000)
    } catch {
      // Clipboard API may not be available
    }
  }

  const outputEntries = $derived(
    outputs ? Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b)) : []
  )
</script>

{#if !outputs || outputEntries.length === 0}
  <div class="text-text-dim text-sm py-8 text-center">No outputs available.</div>
{:else}
  <!-- View toggle -->
  <div class="flex items-center justify-between mb-4">
    <div class="text-text-muted text-sm">
      {outputEntries.length} output{outputEntries.length === 1 ? "" : "s"}
    </div>
    <button
      class="text-xs text-text-muted hover:text-text transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
      onclick={() => {
        showJson = !showJson
        localStorage.setItem(STORAGE_KEY, showJson ? "json" : "table")
      }}
    >
      {showJson ? "Table view" : "JSON view"}
    </button>
  </div>

  {#if showJson}
    <!-- JSON view -->
    <div class="relative bg-surface-raised border border-border rounded-lg p-4 font-mono text-xs text-text-muted overflow-x-auto">
      <button
        class="absolute top-2 right-2 text-text-dim hover:text-text transition-colors p-1.5 rounded hover:bg-surface-overlay"
        onclick={copyJson}
        title="Copy JSON"
      >
        {#if copiedJson}
          <svg class="w-4 h-4 text-status-ready" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else}
          <svg class="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="5" y="5" width="8" height="10" rx="1"/>
            <path d="M3 11V3a1 1 0 0 1 1-1h6"/>
          </svg>
        {/if}
      </button>
      <pre>{JSON.stringify(outputs, null, 2)}</pre>
    </div>
  {:else}
    <!-- Table view -->
    <div class="border border-border rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-surface-raised text-text-muted text-left">
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Value</th>
            <th class="px-4 py-2 font-medium w-20"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border-subtle">
          {#each outputEntries as [key, output] (key)}
            {@const isSensitive = output.sensitive === true}
            {@const isRevealed = revealedKeys.has(key)}
            {@const multiline = isMultiline(output.value)}
            <tr class="hover:bg-surface-raised/50 transition-colors align-top">
              <td class="px-4 py-2.5 font-mono text-xs text-text">
                <div class="flex items-center gap-2">
                  {key}
                  {#if isSensitive}
                    <span class="text-status-planning text-[10px] px-1.5 py-0.5 bg-status-planning/10 rounded">
                      sensitive
                    </span>
                  {/if}
                </div>
              </td>
              <td class="px-4 py-2.5 font-mono text-xs text-text-muted">
                {#if isSensitive && !isRevealed}
                  <span class="text-text-dim italic">********</span>
                {:else if multiline}
                  <pre class="whitespace-pre-wrap break-all max-w-lg">{formatValue(output.value)}</pre>
                {:else}
                  <span class="break-all">{formatValue(output.value)}</span>
                {/if}
              </td>
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-1">
                  {#if isSensitive}
                    <button
                      class="text-xs text-text-dim hover:text-text transition-colors px-1.5 py-0.5 rounded hover:bg-surface-overlay"
                      onclick={() => toggleReveal(key)}
                      title={isRevealed ? "Hide value" : "Reveal value"}
                    >
                      {isRevealed ? "hide" : "show"}
                    </button>
                  {/if}
                  <button
                    class="text-text-dim hover:text-text transition-colors p-1 rounded hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed"
                    onclick={() => copyValue(key, output.value)}
                    title="Copy value"
                    disabled={isSensitive && !isRevealed}
                  >
                    {#if copiedKey === key}
                      <svg class="w-3.5 h-3.5 text-status-ready" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    {:else}
                      <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="5" y="5" width="8" height="10" rx="1"/>
                        <path d="M3 11V3a1 1 0 0 1 1-1h6"/>
                      </svg>
                    {/if}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}
