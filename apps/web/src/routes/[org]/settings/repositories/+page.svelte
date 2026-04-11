<script lang="ts">
  import { onMount } from "svelte"
  import ActionButton from "$lib/components/ActionButton.svelte"
  import {
    listGithubInstallations,
    listInstallationRepos,
    listRepoMappings,
    createRepoMapping,
    deleteRepoMapping,
  } from "$lib/api"
  import type {
    GithubInstallation,
    GithubRepo,
    RepoMapping,
  } from "$lib/api"
  import { page } from "$app/state"
  import { setLastOrg } from "$lib/auth"

  const GITHUB_APP_NAME = "yaffle-dot-dev"
  let repoInstallations = $state<GithubInstallation[]>([])
  let repoMappings = $state<RepoMapping[]>([])
  let repoLoading = $state(false)
  let repoError = $state<string | null>(null)
  let showRepoAddFlow = $state(false)
  let repoSelectedInstallation = $state<GithubInstallation | null>(null)
  let repoAvailableRepos = $state<GithubRepo[]>([])
  let repoLoadingRepos = $state(false)
  let repoSelectedIds = $state<Set<number>>(new Set())
  let repoAdding = $state(false)

  const org = $derived(page.params.org ?? "")

  async function loadRepoMappings() {
    repoLoading = true
    repoError = null
    try {
      const res = await listRepoMappings(org)
      repoMappings = res.data
    } catch (e) {
      repoError = e instanceof Error ? e.message : String(e)
    } finally {
      repoLoading = false
    }
  }

  async function startRepoAddFlow() {
    showRepoAddFlow = true
    repoSelectedInstallation = null
    repoAvailableRepos = []
    repoSelectedIds = new Set()
    repoError = null
    try {
      const res = await listGithubInstallations()
      repoInstallations = res.data
    } catch (e) {
      repoError = e instanceof Error ? e.message : String(e)
    }
  }

  async function selectRepoInstallation(install: GithubInstallation) {
    repoSelectedInstallation = install
    repoLoadingRepos = true
    repoSelectedIds = new Set()
    try {
      const res = await listInstallationRepos(install.installationId, org)
      repoAvailableRepos = res.data
    } catch (e) {
      repoError = e instanceof Error ? e.message : String(e)
      repoAvailableRepos = []
    } finally {
      repoLoadingRepos = false
    }
  }

  function toggleRepoSelection(githubId: number) {
    const repo = repoAvailableRepos.find((entry) => entry.githubId === githubId)
    if (!repo || repo.mappingStatus !== "available") return

    const next = new Set(repoSelectedIds)
    if (next.has(githubId)) { next.delete(githubId) } else { next.add(githubId) }
    repoSelectedIds = next
  }

  function getRepoStatusLabel(repo: GithubRepo): string | null {
    if (repo.mappingStatus === "linked_current_org") {
      return "Already linked in this org"
    }

    if (repo.mappingStatus === "linked_other_org") {
      return repo.linkedOrgSlug
        ? `Owned by ${repo.linkedOrgSlug}`
        : "Already linked to another Yaffle org"
    }

    return null
  }

  function rememberCurrentOrg() {
    setLastOrg(org)
  }

  async function addSelectedRepos() {
    if (!repoSelectedInstallation || repoSelectedIds.size === 0) return
    repoAdding = true
    repoError = null
    try {
      for (const repoId of repoSelectedIds) {
        await createRepoMapping(org, {
          installationId: repoSelectedInstallation.installationId,
          githubRepoId: repoId,
        })
      }
      showRepoAddFlow = false
      await loadRepoMappings()
    } catch (e) {
      repoError = e instanceof Error ? e.message : String(e)
    } finally {
      repoAdding = false
    }
  }

  async function removeRepoMappingHandler(mapping: RepoMapping) {
    try {
      await deleteRepoMapping(org, mapping.installationId, mapping.githubRepoId)
      repoMappings = repoMappings.filter((m) => m.id !== mapping.id)
    } catch (e) {
      repoError = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(() => {
    void loadRepoMappings()
  })
</script>

<section class="space-y-2 border-b border-border pb-6">
  <div class="flex items-end justify-between gap-4">
    <div>
      <h2 class="text-2xl font-semibold text-text">Repositories</h2>
      <p class="mt-1 max-w-3xl text-sm text-text-muted">
        Manage which GitHub repositories are linked to this organization.
        Only linked repositories will trigger Yaffle runs.
      </p>
    </div>
    {#if !showRepoAddFlow}
      <ActionButton onclick={startRepoAddFlow}>
        Add repositories
      </ActionButton>
    {/if}
  </div>
</section>

{#if repoError}
  <div class="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
    {repoError}
  </div>
{/if}

{#if showRepoAddFlow}
  <div class="rounded-xl border border-border bg-surface-raised p-5 space-y-4">
    {#if !repoSelectedInstallation}
      <div class="space-y-3">
        <h3 class="text-sm font-medium text-text">Select a GitHub account</h3>
        {#if repoInstallations.length === 0}
          <div class="text-sm text-text-muted py-4 text-center space-y-3">
            <p>No GitHub App installations found for your GitHub user or orgs.</p>
            <a
              href="https://github.com/apps/{GITHUB_APP_NAME}/installations/new"
              target="_blank"
              rel="noopener noreferrer"
              onclick={rememberCurrentOrg}
              class="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                     border border-border hover:border-yaffle-500/40
                     text-sm text-text-muted hover:text-text transition-colors"
            >
              Install the Yaffle GitHub App
            </a>
          </div>
        {:else}
          <div class="grid grid-cols-1 gap-2">
            {#each repoInstallations as install (install.installationId)}
              <button
                onclick={() => selectRepoInstallation(install)}
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
              onclick={rememberCurrentOrg}
              class="text-xs text-text-dim hover:text-yaffle-400 transition-colors"
            >
              Don't see your account? Install the GitHub App
            </a>
          </div>
        {/if}
      </div>
    {:else}
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-medium text-text">
            Select repositories from {repoSelectedInstallation.githubOrgLogin}
          </h3>
          <button
            onclick={() => { repoSelectedInstallation = null; repoAvailableRepos = []; repoSelectedIds = new Set() }}
            class="text-xs text-text-dim hover:text-text transition-colors"
          >
            Back
          </button>
        </div>

        {#if repoLoadingRepos}
          <div class="text-sm text-text-muted py-4 text-center">Loading repositories...</div>
        {:else if repoAvailableRepos.length === 0}
          <div class="text-sm text-text-muted py-4 text-center">
            No repositories found for this installation.
          </div>
        {:else}
          <div class="max-h-80 overflow-y-auto space-y-1">
            {#each repoAvailableRepos as repo (repo.githubId)}
              {@const statusLabel = getRepoStatusLabel(repo)}
              <label
                class="flex items-center gap-3 p-2 rounded-lg transition-colors
                       {repo.mappingStatus === 'available'
                         ? 'hover:bg-surface-overlay cursor-pointer'
                         : 'opacity-70 cursor-not-allowed'}"
              >
                <input
                  type="checkbox"
                  checked={repoSelectedIds.has(repo.githubId)}
                  disabled={repo.mappingStatus !== "available"}
                  onchange={() => toggleRepoSelection(repo.githubId)}
                  class="rounded"
                />
                <div>
                  <div class="text-sm text-text">{repo.name}</div>
                  <div class="text-xs text-text-dim">{repo.fullName}</div>
                  {#if statusLabel}
                    <div class="text-xs text-amber-300 mt-1">{statusLabel}</div>
                  {/if}
                </div>
                {#if repo.isPrivate}
                  <span class="ml-auto text-xs text-text-dim border border-border rounded px-1.5 py-0.5">private</span>
                {/if}
              </label>
            {/each}
          </div>

          <div class="flex items-center justify-between pt-2">
            <span class="text-xs text-text-dim">{repoSelectedIds.size} selected</span>
            <button
              onclick={addSelectedRepos}
              disabled={repoAdding || repoSelectedIds.size === 0}
              class="px-4 py-2 rounded-lg bg-yaffle-500 hover:bg-yaffle-400
                     text-white text-sm font-medium transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {repoAdding ? "Adding..." : `Add ${repoSelectedIds.size} repo${repoSelectedIds.size === 1 ? "" : "s"}`}
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <div class="flex justify-end pt-2 border-t border-border">
      <button
        onclick={() => showRepoAddFlow = false}
        class="text-sm text-text-dim hover:text-text transition-colors"
      >
        Cancel
      </button>
    </div>
  </div>
{/if}

{#if repoLoading}
  <div class="text-sm text-text-muted py-8 text-center">Loading repositories...</div>
{:else if repoMappings.length === 0 && !showRepoAddFlow}
  <div class="border border-dashed border-border rounded-lg p-6 text-sm text-text-dim text-center space-y-2">
    <p>No repositories linked yet.</p>
    <p>Link GitHub repositories to start receiving webhook events and running infrastructure previews.</p>
  </div>
{:else if repoMappings.length > 0}
  <div class="rounded-xl border border-border bg-surface-raised overflow-hidden">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-border text-left text-xs text-text-dim">
          <th class="px-4 py-2 font-medium">Repository</th>
          <th class="px-4 py-2 font-medium">Linked by</th>
          <th class="px-4 py-2 font-medium">Linked on</th>
          <th class="px-4 py-2 font-medium"></th>
        </tr>
      </thead>
      <tbody>
        {#each repoMappings as mapping (mapping.id)}
          <tr class="border-b border-border last:border-0 hover:bg-surface-overlay/50 transition-colors">
            <td class="px-4 py-3">
              {#if mapping.repoFullName}
                <a
                  href="https://github.com/{mapping.repoFullName}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-text hover:text-yaffle-400 transition-colors"
                >
                  {mapping.repoFullName}
                </a>
              {:else if mapping.githubOrgLogin}
                <span class="text-text-muted">{mapping.githubOrgLogin}/???</span>
                <span class="text-xs text-text-dim ml-1">(awaiting first webhook)</span>
              {:else}
                <span class="text-text-muted font-mono">repo:{mapping.githubRepoId}</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-text-muted">{mapping.createdByName ?? "unknown"}</td>
            <td class="px-4 py-3 text-text-dim text-xs">{new Date(mapping.createdAt).toLocaleDateString()}</td>
            <td class="px-4 py-3 text-right">
              <button
                onclick={() => removeRepoMappingHandler(mapping)}
                class="text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Unlink
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
