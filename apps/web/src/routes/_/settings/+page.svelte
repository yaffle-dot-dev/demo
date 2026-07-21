<script lang="ts">
  import { onMount } from "svelte"
  import AsyncLoader from "$lib/components/AsyncLoader.svelte"
  import ActionButton from "$lib/components/ActionButton.svelte"
  import { useSession } from "$lib/auth"
  import {
    getPrivateBetaAccess,
    listPrivateBetaInvites,
    revokePrivateBetaInvite,
    upsertPrivateBetaInvite,
    type PrivateBetaAccess,
    type PrivateBetaInvite,
  } from "$lib/api"

  const session = useSession()
  const user = $derived($session.data?.user)

  // API key state
  let apiKeys = $state<ApiKey[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)

  // Create key modal state
  let showCreateModal = $state(false)
  let newKeyName = $state("")
  let newKeyExpiration = $state("90") // days
  let newKeyOrgId = $state("")
  let newKeyRepo = $state("")
  let newKeyAccess = $state<"read" | "write">("read")
  let creating = $state(false)
  let newlyCreatedKey = $state<string | null>(null)
  let newlyCreatedSummary = $state<{ access: string; orgName: string; expiresAt: string | null } | null>(null)
  let keyCopied = $state(false)
  let orgs = $state<UserOrg[]>([])
  let privateBetaAccess = $state<PrivateBetaAccess | null>(null)
  let privateBetaInvites = $state<PrivateBetaInvite[]>([])
  let privateBetaLoading = $state(false)
  let privateBetaError = $state<string | null>(null)
  let inviteEmail = $state("")
  let inviteGithubLogin = $state("")
  let inviteNote = $state("")
  let savingInvite = $state(false)
  let revokingInviteId = $state<string | null>(null)

  // Expiration options (in days)
  const expirationOptions = [
    { value: "7", label: "7 days" },
    { value: "30", label: "30 days" },
    { value: "90", label: "90 days" },
    { value: "180", label: "180 days" },
    { value: "365", label: "1 year" },
  ]

  const accessOptions = [
    {
      value: "read",
      label: "Read-only",
      description: "List previews, stream status, and fetch outputs.",
    },
    {
      value: "write",
      label: "Read + write",
      description: "Includes preview actions like rerun, pause, and apply.",
    },
  ]

  // Delete confirmation
  let deletingKeyId = $state<string | null>(null)

  interface ApiKey {
    id: string
    name: string | null
    start: string | null
    createdAt: Date
    expiresAt: Date | null
    enabled: boolean
    access: "read" | "write"
    orgId: string | null
    orgSlug: string | null
    orgName: string | null
    repo: string | null
  }

  interface UserOrg {
    id: string
    slug: string
    name: string
    role: string
  }

  const isPrivateBetaOperator = $derived(privateBetaAccess?.isOperator ?? false)

  async function loadApiKeys() {
    loading = true
    error = null
    try {
      const res = await fetch("/api/users/api-keys", {
        credentials: "include",
      })
      const body = await res.json()
      if (!res.ok) {
        error = body.error?.message ?? "Failed to load API keys"
        apiKeys = []
      } else {
        apiKeys = body.data ?? []
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load API keys"
      apiKeys = []
    } finally {
      loading = false
    }
  }

  async function loadOrgs() {
    try {
      const res = await fetch("/api/orgs", { credentials: "include" })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.error?.message ?? "Failed to load organizations")
      }
      orgs = body.data ?? []
      if (!newKeyOrgId && orgs.length > 0) {
        newKeyOrgId = orgs[0].id
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load organizations"
      orgs = []
    }
  }

  async function loadPrivateBetaState() {
    try {
      const access = await getPrivateBetaAccess()
      privateBetaAccess = access.data

      if (access.data.isOperator) {
        privateBetaLoading = true
        const invites = await listPrivateBetaInvites()
        privateBetaInvites = invites.data
      }
    } catch (e) {
      privateBetaError = e instanceof Error ? e.message : "Failed to load private beta state"
      privateBetaInvites = []
    } finally {
      privateBetaLoading = false
    }
  }

  async function saveInvite() {
    if (!inviteEmail.trim() && !inviteGithubLogin.trim()) return

    savingInvite = true
    privateBetaError = null

    try {
      await upsertPrivateBetaInvite({
        email: inviteEmail.trim() || undefined,
        githubLogin: inviteGithubLogin.trim() || undefined,
        note: inviteNote.trim() || undefined,
      })

      inviteEmail = ""
      inviteGithubLogin = ""
      inviteNote = ""

      const invites = await listPrivateBetaInvites()
      privateBetaInvites = invites.data
    } catch (e) {
      privateBetaError = e instanceof Error ? e.message : "Failed to save invite"
    } finally {
      savingInvite = false
    }
  }

  async function revokeInvite(inviteId: string) {
    revokingInviteId = inviteId
    privateBetaError = null

    try {
      await revokePrivateBetaInvite(inviteId)
      const invites = await listPrivateBetaInvites()
      privateBetaInvites = invites.data
    } catch (e) {
      privateBetaError = e instanceof Error ? e.message : "Failed to revoke invite"
    } finally {
      revokingInviteId = null
    }
  }

  async function createApiKey() {
    if (!newKeyName.trim() || !newKeyOrgId) return
    creating = true
    error = null
    try {
      const expiresIn = parseInt(newKeyExpiration) * 24 * 60 * 60

      const res = await fetch("/api/users/api-keys", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: newKeyName.trim(),
          orgId: newKeyOrgId,
          access: newKeyAccess,
          repo: newKeyRepo.trim() || undefined,
          expiresIn,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        error = body.error?.message ?? "Failed to create API key"
      } else if (body.data?.key) {
        newlyCreatedKey = body.data.key
        newlyCreatedSummary = {
          access: body.data.access,
          orgName: body.data.orgName,
          expiresAt: body.data.expiresAt,
        }
        newKeyName = ""
        newKeyExpiration = "90"
        newKeyAccess = "read"
        newKeyRepo = ""
        await loadApiKeys()
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to create API key"
    } finally {
      creating = false
    }
  }

  async function deleteApiKey(keyId: string) {
    deletingKeyId = keyId
    error = null
    try {
      const res = await fetch(`/api/users/api-keys/${keyId}`, {
        method: "DELETE",
        credentials: "include",
      })
      const body = await res.json()
      if (!res.ok) {
        error = body.error?.message ?? "Failed to delete API key"
      } else {
        await loadApiKeys()
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to delete API key"
    } finally {
      deletingKeyId = null
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
    keyCopied = true
    setTimeout(() => keyCopied = false, 2000)
  }

  function closeCreateModal() {
    showCreateModal = false
    newlyCreatedKey = null
    newlyCreatedSummary = null
    newKeyName = ""
    newKeyAccess = "read"
    newKeyRepo = ""
    keyCopied = false
  }

  function handleModalBackdropKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      closeCreateModal()
    }
  }

  function handleModalPanelKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      closeCreateModal()
      return
    }

    event.stopPropagation()
  }

  function formatDate(date: Date | string | null): string {
    if (!date) return "Never"
    const d = date instanceof Date ? date : new Date(date)
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  }

  onMount(() => {
    loadApiKeys()
    loadOrgs()
    loadPrivateBetaState()
  })
</script>

<div class="space-y-8">
  <div>
    <h1 class="text-2xl font-bold text-text">User Settings</h1>
    <p class="text-text-muted mt-1">Manage your account and API keys</p>
  </div>

  {#if user}
    <!-- Profile Section -->
    <section class="space-y-4">
      <h2 class="text-lg font-semibold text-text">Profile</h2>
      <div class="bg-surface-raised border border-border rounded-lg p-4">
        <div class="flex items-center gap-4">
          {#if user.image}
            <img src={user.image} alt={user.name} class="w-16 h-16 rounded-full" />
          {:else}
            <div class="w-16 h-16 rounded-full bg-surface-overlay flex items-center justify-center text-2xl text-text-dim">
              {user.name?.charAt(0).toUpperCase() ?? "?"}
            </div>
          {/if}
          <div>
            <div class="text-lg font-medium text-text">{user.name}</div>
            <div class="text-sm text-text-muted">{user.email}</div>
          </div>
        </div>
      </div>
    </section>

    {#if isPrivateBetaOperator}
      <section class="space-y-4">
        <div>
          <h2 class="text-lg font-semibold text-text">Private Beta Invites</h2>
          <p class="text-sm text-text-muted">Allow specific GitHub users or emails to create their first Yaffle org.</p>
        </div>

        {#if privateBetaError}
          <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
            {privateBetaError}
          </div>
        {/if}

        <div class="bg-surface-raised border border-border rounded-lg p-4 space-y-4">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label for="inviteEmail" class="block text-sm font-medium text-text mb-1">Invite email</label>
              <input
                id="inviteEmail"
                type="email"
                bind:value={inviteEmail}
                placeholder="friend@example.com"
                class="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
              />
            </div>
            <div>
              <label for="inviteGithubLogin" class="block text-sm font-medium text-text mb-1">GitHub login</label>
              <input
                id="inviteGithubLogin"
                type="text"
                bind:value={inviteGithubLogin}
                placeholder="lamalex"
                class="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
              />
            </div>
          </div>

          <div>
            <label for="inviteNote" class="block text-sm font-medium text-text mb-1">Note</label>
            <input
              id="inviteNote"
              type="text"
              bind:value={inviteNote}
              placeholder="friend from infra slack"
              class="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
            />
          </div>

          <div class="flex justify-end">
            <ActionButton disabled={savingInvite || (!inviteEmail.trim() && !inviteGithubLogin.trim())} onclick={saveInvite}>
              {savingInvite ? "Saving..." : "Save invite"}
            </ActionButton>
          </div>
        </div>

        <div class="bg-surface-raised border border-border rounded-lg overflow-hidden">
          {#if privateBetaLoading}
            <div class="p-6">
              <AsyncLoader
                title="Loading invites"
                message="Fetching the current private beta allowlist."
              />
            </div>
          {:else if privateBetaInvites.length === 0}
            <div class="p-8 text-center text-text-dim">
              No beta invites yet.
            </div>
          {:else}
            <table class="w-full">
              <thead class="bg-surface-overlay">
                <tr class="text-left text-xs text-text-muted uppercase tracking-wider">
                  <th class="px-4 py-2">Identity</th>
                  <th class="px-4 py-2">Note</th>
                  <th class="px-4 py-2">Status</th>
                  <th class="px-4 py-2">Invited By</th>
                  <th class="px-4 py-2">Created</th>
                  <th class="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                {#each privateBetaInvites as invite (invite.id)}
                  <tr class="hover:bg-surface-overlay/50 transition-colors">
                    <td class="px-4 py-3 text-sm text-text">
                      <div>{invite.email ?? "-"}</div>
                      <div class="text-xs text-text-dim">{invite.githubLogin ? `@${invite.githubLogin}` : ""}</div>
                    </td>
                    <td class="px-4 py-3 text-sm text-text-muted">{invite.note ?? "-"}</td>
                    <td class="px-4 py-3 text-sm text-text-muted">
                      {#if invite.revokedAt}
                        Revoked
                      {:else if invite.claimedAt}
                        Claimed by {invite.claimedByName ?? "user"}
                      {:else}
                        Active
                      {/if}
                    </td>
                    <td class="px-4 py-3 text-sm text-text-muted">{invite.invitedByName ?? "Unknown"}</td>
                    <td class="px-4 py-3 text-sm text-text-muted">{formatDate(invite.createdAt)}</td>
                    <td class="px-4 py-3 text-right">
                      {#if !invite.revokedAt}
                        <button
                          class="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                          disabled={revokingInviteId === invite.id}
                          onclick={() => revokeInvite(invite.id)}
                        >
                          {revokingInviteId === invite.id ? "Revoking..." : "Revoke"}
                        </button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      </section>
    {/if}

    <!-- API Keys Section -->
    <section class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-semibold text-text">API Keys</h2>
          <p class="text-sm text-text-muted">Manage API keys for CLI and CI access</p>
        </div>
        <ActionButton onclick={() => showCreateModal = true}>
          Create API Key
        </ActionButton>
      </div>

      {#if error}
        <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      {/if}

      <div class="bg-surface-raised border border-border rounded-lg overflow-hidden">
        {#if loading}
          <div class="p-6">
            <AsyncLoader
              title="Loading API keys"
              message="Fetching your CLI and CI authentication keys."
            />
          </div>
        {:else if apiKeys.length === 0}
          <div class="p-8 text-center text-text-dim">
            No API keys yet. Create one to use the Yaffle CLI.
          </div>
        {:else}
          <table class="w-full">
            <thead class="bg-surface-overlay">
              <tr class="text-left text-xs text-text-muted uppercase tracking-wider">
                <th class="px-4 py-2">Name</th>
                <th class="px-4 py-2">Key</th>
                <th class="px-4 py-2">Created</th>
                <th class="px-4 py-2">Expires</th>
                <th class="px-4 py-2">Access</th>
                <th class="px-4 py-2">Org</th>
                <th class="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              {#each apiKeys as key (key.id)}
                <tr class="hover:bg-surface-overlay/50 transition-colors">
                  <td class="px-4 py-3 text-sm text-text">
                    {key.name ?? "Unnamed"}
                  </td>
                  <td class="px-4 py-3 text-sm font-mono text-text-muted">
                    {key.start ?? "yfl_"}...
                  </td>
                  <td class="px-4 py-3 text-sm text-text-muted">
                    {formatDate(key.createdAt)}
                  </td>
                  <td class="px-4 py-3 text-sm text-text-muted">
                    {formatDate(key.expiresAt)}
                  </td>
                  <td class="px-4 py-3 text-sm text-text-muted">
                    {key.access === "write" ? "Read + write" : "Read-only"}
                  </td>
                  <td class="px-4 py-3 text-sm text-text-muted">
                    {key.orgName ?? key.orgSlug ?? "Unknown org"}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <button
                      class="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                      disabled={deletingKeyId === key.id}
                      onclick={() => deleteApiKey(key.id)}
                    >
                      {deletingKeyId === key.id ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </section>
  {:else}
    <AsyncLoader
      variant="page"
      title="Loading settings"
      message="Preparing your user settings and authentication data."
    />
  {/if}
</div>

<!-- Create API Key Modal -->
{#if showCreateModal}
  <div
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    role="button"
    tabindex="0"
    aria-label="Close API key modal"
    onclick={closeCreateModal}
    onkeydown={handleModalBackdropKeydown}
  >
    <div
      class="bg-surface-raised border border-border rounded-lg shadow-xl w-full max-w-md mx-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-api-key-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleModalPanelKeydown}
    >
      {#if newlyCreatedKey}
        <!-- Success state: show the key -->
        <div class="p-6 space-y-4">
          <div>
            <h3 id="create-api-key-title" class="text-lg font-semibold text-text">API Key Created</h3>
            <p class="text-sm text-text-muted mt-1">
              Copy this key now. You won't be able to see it again.
            </p>
          </div>

          <div class="bg-surface border border-border rounded p-3">
            <div class="flex items-center gap-2">
              <code class="flex-1 text-sm font-mono text-yaffle-400 break-all">
                {newlyCreatedKey}
              </code>
              <button
                class="shrink-0 text-text-dim hover:text-text transition-colors p-1.5 rounded hover:bg-surface-overlay"
                onclick={() => copyToClipboard(newlyCreatedKey!)}
                title="Copy API key"
              >
                {#if keyCopied}
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
            </div>
          </div>

          <div class="bg-yellow-500/10 border border-yellow-500/30 rounded p-3 text-sm text-yellow-400">
            <div>Store this key securely. Use it with the Yaffle CLI:</div>
            <code class="block mt-2 font-mono text-xs">yaffle login</code>
            {#if newlyCreatedSummary}
              <div class="mt-3 text-yellow-300">
                Scope: {newlyCreatedSummary.access === "write" ? "Read + write" : "Read-only"} for {newlyCreatedSummary.orgName}.<br />
                Expires: {formatDate(newlyCreatedSummary.expiresAt)}
              </div>
            {/if}
          </div>

          <div class="flex justify-end">
            <button
              class="px-4 py-2 text-sm font-medium bg-yaffle-500 text-white rounded hover:bg-yaffle-600 transition-colors"
              onclick={closeCreateModal}
            >
              Done
            </button>
          </div>
        </div>
      {:else}
        <!-- Create form -->
        <div class="p-6 space-y-4">
          <div>
            <h3 id="create-api-key-title" class="text-lg font-semibold text-text">Create API Key</h3>
            <p class="text-sm text-text-muted mt-1">
              Create an org-scoped API key for CLI or CI access.
            </p>
          </div>

          <div>
            <label for="keyOrg" class="block text-sm font-medium text-text mb-1">
              Organization
            </label>
            <select
              id="keyOrg"
              bind:value={newKeyOrgId}
              class="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
            >
              {#each orgs as org}
                <option value={org.id}>{org.name} ({org.slug})</option>
              {/each}
            </select>
          </div>

          <div>
            <label for="keyName" class="block text-sm font-medium text-text mb-1">
              Name
            </label>
            <input
              id="keyName"
              type="text"
              bind:value={newKeyName}
              placeholder="e.g., MacBook CLI, GitHub Actions"
              class="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
            />
          </div>

          <div>
            <label for="keyRepo" class="block text-sm font-medium text-text mb-1">
              Repository scope <span class="font-normal text-text-dim">(optional)</span>
            </label>
            <input
              id="keyRepo"
              type="text"
              bind:value={newKeyRepo}
              placeholder="e.g., yaffle"
              class="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
            />
            <p class="mt-2 text-xs text-text-dim">
              Required when this key fetches outputs through the Outputs Action.
            </p>
          </div>

          <div>
            <label for="keyExpiration" class="block text-sm font-medium text-text mb-1">
              Expiration
            </label>
            <select
              id="keyExpiration"
              bind:value={newKeyExpiration}
              class="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
            >
              {#each expirationOptions as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </div>

          <div>
            <label for="keyAccess" class="block text-sm font-medium text-text mb-1">
              Access
            </label>
            <select
              id="keyAccess"
              bind:value={newKeyAccess}
              class="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-yaffle-500/50 focus:border-yaffle-500"
            >
              {#each accessOptions as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
            <p class="mt-2 text-xs text-text-dim">
              {accessOptions.find((opt) => opt.value === newKeyAccess)?.description}
            </p>
          </div>

          <div class="flex justify-end gap-3">
            <button
              class="px-4 py-2 text-sm text-text-muted hover:text-text transition-colors"
              onclick={closeCreateModal}
            >
              Cancel
            </button>
            <button
              class="px-4 py-2 text-sm font-medium bg-yaffle-500 text-white rounded hover:bg-yaffle-600 transition-colors disabled:opacity-50"
              disabled={creating || !newKeyName.trim() || !newKeyOrgId}
              onclick={createApiKey}
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
