<script lang="ts">
  import { page } from "$app/state"
  import { base } from "$app/paths"

  const navItems = [
    { label: "Members", path: "members" },
    { label: "Repositories", path: "repositories" },
    { label: "Connections", path: "connections" },
    { label: "Support", path: "support" },
  ]

  let { children } = $props()

  function isActive(itemPath: string): boolean {
    return page.url.pathname.includes(`/settings/${itemPath}`)
  }

  function navHref(itemPath: string): string {
    return `${base}/${page.params.org}/settings/${itemPath}`
  }
</script>

<div class="grid gap-10 lg:grid-cols-[180px_minmax(0,1fr)]">
  <aside class="space-y-6">
    <nav class="space-y-1">
      {#each navItems as item}
        <a
          href={navHref(item.path)}
          class={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${isActive(item.path)
            ? "bg-surface-raised text-text"
            : "text-text-muted hover:bg-surface hover:text-text"}`}
        >
          {item.label}
        </a>
      {/each}
    </nav>
  </aside>

  <div class="min-w-0 space-y-8">
    {@render children()}
  </div>
</div>
