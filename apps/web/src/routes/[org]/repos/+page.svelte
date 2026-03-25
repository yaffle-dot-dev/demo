<script lang="ts">
  import { browser } from "$app/environment"
  import { page } from "$app/state"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { onMount } from "svelte"
  import {
    listGithubInstallations,
    listInstallationRepos,
    listRepoMappings,
    createRepoMapping,
    deleteRepoMapping,
    type GithubInstallation,
    type GithubRepo,
    type RepoMapping,
  } from "$lib/api"
  import { useSession } from "$lib/auth"

  const org = $derived(page.params.org ?? "")
  const session = useSession()

  const GITHUB_APP_NAME = "yaffle-dot-dev"

  // State
  let installations = $state<GithubInstallation[]>([])
  let mappings = $state<RepoMapping[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)

  // Add repos flow
  let showAddFlow = $state(false)
  let selectedInstallation = $state<GithubInstallation | null>(null)
  let availableRepos = $state<GithubRepo[]>([])
  let loadingRepos = $state(false)
  let selectedRepoIds = $state<Set<number>>(new Set())
  let adding = $state(false)

  async function load() {
    loading = true
    error = null
    try {
      const res = await listRepoMappings(org)
      mappings = res.data
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function startAddFlow() {
    showAddFlow = true
    selectedInstallation = null
    availableRepos = []
    selectedRepoIds = new Set()
    error = null

    try {
      const res = await listGithubInstallations()
      installations = res.data
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function selectInstallation(install: GithubInstallation) {
    selectedInstallation = install
    loadingRepos = true
    selectedRepoIds = new Set()

    try {
      const res = await listInstallationRepos(install.installationId)
      // Filter out repos that are already mapped
      const mappedRepoIds = new Set(mappings.map((m) => m.githubRepoId))
      availableRepos = res.data.filter((r) => !mappedRepoIds.has(r.githubId))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      availableRepos = []
    } finally {
      loadingRepos = false
    }
  }

  function toggleRepo(githubId: number) {
    const next = new Set(selectedRepoIds)
    if (next.has(githubId)) {
      next.delete(githubId)
    } else {
      next.add(githubId)
    }
    selectedRepoIds = next
  }

  async function addSelectedRepos() {
    if (!selectedInstallation || selectedRepoIds.size === 0) return
    adding = true
    error = null

    try {
      for (const repoId of selectedRepoIds) {
        await createRepoMapping(org, {
          installationId: selectedInstallation.installationId,
          githubRepoId: repoId,
        })
      }
      showAddFlow = false
      await load()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      adding = false
    }
  }

  async function removeMappingHandler(mapping: RepoMapping) {
    try {
      await deleteRepoMapping(org, mapping.installationId, mapping.githubRepoId)
      mappings = mappings.filter((m) => m.id !== mapping.id)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  let hasLoaded = false

  onMount(() => {
    if (!browser) return
    const unsubscribe = session.subscribe((state) => {
      if (state.isPending) return
      if (hasLoaded) return
      hasLoaded = true

      if (!state.data?.user) {
        goto(`${base}/`)
        return
      }
      load()
    })
    return unsubscribe
  })
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold text-text">Repositories</h1>
      <p class="text-sm text-text-muted mt-1">
        Manage which GitHub repositories are linked to this organization.
      </p>
    </div>
    {#if !showAddFlow}
      <button
        onclick={startAddFlow}
        class="px-4 py-2 rounded-lg bg-yaffle-500 hover:bg-yaffle-400
               text-white text-sm font-medium transition-colors"
      >
        Add repositories
      </button>
    {/if}
  </div>

  {#if error}
    <div class="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
      {error}
    </div>
  {/if}

  <!-- Add repos flow -->
  {#if showAddFlow}
    <div class="rounded-xl border border-border bg-surface-raised p-5 space-y-4">
      {#if !selectedInstallation}
        <div class="space-y-3">
          <h2 class="text-sm font-medium text-text">Select a GitHub organization</h2>
          {#if installations.length === 0}
            <div class="text-sm text-text-muted py-4 text-center space-y-3">
              <p>No GitHub App installations found.</p>
              <a
                href="https://github.com/apps/{GITHUB_APP_NAME}/installations/new"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                       border border-border hover:border-yaffle-500/40
                       text-sm text-text-muted hover:text-text transition-colors"
              >
                Install the Yaffle GitHub App
              </a>
            </div>
          {:else}
            <div class="grid grid-cols-1 gap-2">
              {#each installations as install (install.installationId)}
                <button
                  onclick={() => selectInstallation(install)}
                  class="flex items-center gap-3 p-3 rounded-lg border border-border
                         hover:border-yaffle-500/40 bg-surface transition-colors text-left"
                >
                  <img src={install.avatarUrl} alt="" class="w-8 h-8 rounded-full" />
                  <div>
                    <div class="text-sm font-medium text-text">{install.githubOrgLogin}</div>
                    <div class="text-xs text-text-dim">{install.accountType}</div>
                  </div>
                </button>
              {/each}
            </div>
            <div class="pt-2 text-center">
              <a
                href="https://github.com/apps/{GITHUB_APP_NAME}/installations/new"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-text-dim hover:text-yaffle-400 transition-colors"
              >
                Don't see your org? Install the GitHub App
              </a>
            </div>
          {/if}
        </div>
      {:else}
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-medium text-text">
              Select repositories from {selectedInstallation.githubOrgLogin}
            </h2>
            <button
              onclick={() => { selectedInstallation = null; availableRepos = []; selectedRepoIds = new Set() }}
              class="text-xs text-text-dim hover:text-text transition-colors"
            >
              Back
            </button>
          </div>

          {#if loadingRepos}
            <div class="text-sm text-text-muted py-4 text-center">Loading repositories...</div>
          {:else if availableRepos.length === 0}
            <div class="text-sm text-text-muted py-4 text-center">
              All repositories from this installation are already linked.
            </div>
          {:else}
            <div class="max-h-80 overflow-y-auto space-y-1">
              {#each availableRepos as repo (repo.githubId)}
                <label
                  class="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-overlay
                         transition-colors cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedRepoIds.has(repo.githubId)}
                    onchange={() => toggleRepo(repo.githubId)}
                    class="rounded"
                  />
                  <div>
                    <div class="text-sm text-text">{repo.name}</div>
                    <div class="text-xs text-text-dim">{repo.fullName}</div>
                  </div>
                  {#if repo.isPrivate}
                    <span class="ml-auto text-xs text-text-dim border border-border rounded px-1.5 py-0.5">private</span>
                  {/if}
                </label>
              {/each}
            </div>

            <div class="flex items-center justify-between pt-2">
              <span class="text-xs text-text-dim">
                {selectedRepoIds.size} selected
              </span>
              <button
                onclick={addSelectedRepos}
                disabled={adding || selectedRepoIds.size === 0}
                class="px-4 py-2 rounded-lg bg-yaffle-500 hover:bg-yaffle-400
                       text-white text-sm font-medium transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {adding ? "Adding..." : `Add ${selectedRepoIds.size} repo${selectedRepoIds.size === 1 ? "" : "s"}`}
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <div class="flex justify-end pt-2 border-t border-border">
        <button
          onclick={() => showAddFlow = false}
          class="text-sm text-text-dim hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <!-- Current mappings -->
  {#if loading}
    <div class="text-sm text-text-muted py-8 text-center">Loading repositories...</div>
  {:else if mappings.length === 0 && !showAddFlow}
    <div class="rounded-xl border border-border border-dashed bg-surface p-8 text-center space-y-3">
      <p class="text-text-muted text-sm">No repositories linked yet.</p>
      <p class="text-text-dim text-xs">
        Link GitHub repositories to start receiving webhook events and running infrastructure previews.
      </p>
    </div>
  {:else if mappings.length > 0}
    <div class="rounded-xl border border-border bg-surface-raised overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs text-text-dim">
            <th class="px-4 py-2 font-medium">Repo ID</th>
            <th class="px-4 py-2 font-medium">Installation</th>
            <th class="px-4 py-2 font-medium">Linked</th>
            <th class="px-4 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {#each mappings as mapping (mapping.id)}
            <tr class="border-b border-border last:border-0 hover:bg-surface-overlay/50 transition-colors">
              <td class="px-4 py-3 font-mono text-text">{mapping.githubRepoId}</td>
              <td class="px-4 py-3 font-mono text-text-muted">{mapping.installationId}</td>
              <td class="px-4 py-3 text-text-dim text-xs">
                {new Date(mapping.createdAt).toLocaleDateString()}
              </td>
              <td class="px-4 py-3 text-right">
                <button
                  onclick={() => removeMappingHandler(mapping)}
                  class="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Remove
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
