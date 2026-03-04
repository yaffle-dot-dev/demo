<script lang="ts">
  interface ResourceChange {
    address: string
    type: string
    name: string
    provider_name: string
    change: {
      actions: string[]
      before?: unknown
      after?: unknown
    }
  }

  interface PlanJson {
    resource_changes?: ResourceChange[]
    format_version?: string
  }

  interface Props {
    planJson: PlanJson | null
  }

  let props: Props = $props()

  const planJson = $derived(props.planJson)

  // Group changes by action type
  interface GroupedChanges {
    create: ResourceChange[]
    update: ResourceChange[]
    replace: ResourceChange[]
    delete: ResourceChange[]
    read: ResourceChange[]
    noop: ResourceChange[]
  }

  function groupChanges(changes: ResourceChange[]): GroupedChanges {
    const groups: GroupedChanges = {
      create: [],
      update: [],
      replace: [],
      delete: [],
      read: [],
      noop: [],
    }

    for (const change of changes) {
      const actions = change.change?.actions ?? []

      if (actions.includes("create") && actions.includes("delete")) {
        groups.replace.push(change)
      } else if (actions.includes("create")) {
        groups.create.push(change)
      } else if (actions.includes("delete")) {
        groups.delete.push(change)
      } else if (actions.includes("update")) {
        groups.update.push(change)
      } else if (actions.includes("read")) {
        groups.read.push(change)
      } else if (actions.includes("no-op") || actions.length === 0) {
        groups.noop.push(change)
      }
    }

    return groups
  }

  function actionIcon(group: keyof GroupedChanges): string {
    switch (group) {
      case "create": return "+"
      case "update": return "~"
      case "replace": return "+-"
      case "delete": return "-"
      case "read": return "?"
      default: return ""
    }
  }

  function actionColor(group: keyof GroupedChanges): string {
    switch (group) {
      case "create": return "text-status-ready"
      case "update": return "text-status-planning"
      case "replace": return "text-status-applying"
      case "delete": return "text-status-failed"
      case "read": return "text-text-muted"
      default: return "text-text-dim"
    }
  }

  function actionBgColor(group: keyof GroupedChanges): string {
    switch (group) {
      case "create": return "bg-status-ready/10"
      case "update": return "bg-status-planning/10"
      case "replace": return "bg-status-applying/10"
      case "delete": return "bg-status-failed/10"
      default: return "bg-surface-overlay"
    }
  }

  function groupLabel(group: keyof GroupedChanges): string {
    switch (group) {
      case "create": return "Create"
      case "update": return "Update"
      case "replace": return "Replace"
      case "delete": return "Destroy"
      case "read": return "Read"
      case "noop": return "No changes"
    }
  }

  let expandedSections = $state<Set<string>>(new Set(["create", "update", "replace", "delete"]))

  function toggleSection(section: string) {
    const next = new Set(expandedSections)
    if (next.has(section)) {
      next.delete(section)
    } else {
      next.add(section)
    }
    expandedSections = next
  }

  const changes = $derived(planJson?.resource_changes ?? [])
  const grouped = $derived(groupChanges(changes))
  const totalChanges = $derived(
    grouped.create.length + grouped.update.length + grouped.replace.length + grouped.delete.length
  )
</script>

{#if !planJson}
  <div class="text-text-dim text-sm py-8 text-center">No plan data available.</div>
{:else if totalChanges === 0}
  <div class="bg-surface-raised border border-border rounded-lg p-6 text-center">
    <div class="text-status-ready text-lg mb-1">No changes</div>
    <div class="text-text-muted text-sm">Infrastructure is up-to-date.</div>
  </div>
{:else}
  <!-- Summary bar -->
  <div class="flex items-center gap-4 mb-4 text-sm">
    {#if grouped.create.length > 0}
      <span class="flex items-center gap-1.5">
        <span class="font-mono text-status-ready">+{grouped.create.length}</span>
        <span class="text-text-muted">to create</span>
      </span>
    {/if}
    {#if grouped.update.length > 0}
      <span class="flex items-center gap-1.5">
        <span class="font-mono text-status-planning">~{grouped.update.length}</span>
        <span class="text-text-muted">to update</span>
      </span>
    {/if}
    {#if grouped.replace.length > 0}
      <span class="flex items-center gap-1.5">
        <span class="font-mono text-status-applying">+/-{grouped.replace.length}</span>
        <span class="text-text-muted">to replace</span>
      </span>
    {/if}
    {#if grouped.delete.length > 0}
      <span class="flex items-center gap-1.5">
        <span class="font-mono text-status-failed">-{grouped.delete.length}</span>
        <span class="text-text-muted">to destroy</span>
      </span>
    {/if}
  </div>

  <!-- Grouped sections -->
  <div class="space-y-3">
    {#each (["delete", "replace", "update", "create"] as const) as group}
      {#if grouped[group].length > 0}
        <div class="border border-border rounded-lg overflow-hidden">
          <button
            class="w-full flex items-center justify-between px-4 py-2.5 bg-surface-raised hover:bg-surface-overlay transition-colors text-left"
            onclick={() => toggleSection(group)}
          >
            <div class="flex items-center gap-3">
              <span class="font-mono text-sm w-6 {actionColor(group)}">{actionIcon(group)}</span>
              <span class="font-medium text-sm text-text">{groupLabel(group)}</span>
              <span class="text-text-dim text-xs">({grouped[group].length})</span>
            </div>
            <span class="text-text-dim text-xs">
              {expandedSections.has(group) ? "[-]" : "[+]"}
            </span>
          </button>

          {#if expandedSections.has(group)}
            <div class="divide-y divide-border-subtle">
              {#each grouped[group] as change (change.address)}
                <div class="px-4 py-2 hover:bg-surface-raised/50 transition-colors flex items-start gap-3">
                  <span class="font-mono text-xs w-6 {actionColor(group)} flex-shrink-0 pt-0.5">
                    {actionIcon(group)}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="font-mono text-xs text-text truncate" title={change.address}>
                      {change.address}
                    </div>
                    <div class="text-text-dim text-xs mt-0.5">
                      {change.type}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}
