<script lang="ts">
  import type { OrgProvisioningStatus } from "$lib/sse/types"

  interface Props {
    status: OrgProvisioningStatus | null
    error: string | null
  }

  let { status, error }: Props = $props()

  const isWorking = $derived(status === "pending" || status === "provisioning")
  const isFailed = $derived(status === "failed")
</script>

{#if isWorking}
  <div class="flex flex-col items-center justify-center min-h-[60vh] px-4">
    <div class="relative mb-8">
      <!-- Spinner -->
      <div class="w-16 h-16 border-4 border-yaffle-500/20 border-t-yaffle-500 rounded-full animate-spin"></div>
    </div>
    
    <h1 class="text-2xl font-semibold text-text mb-2">Setting up your organization</h1>
    <p class="text-text-muted text-center max-w-md">
      We're provisioning secure infrastructure for your team. This usually takes a few minutes.
    </p>
  </div>
{:else if isFailed}
  <div class="flex flex-col items-center justify-center min-h-[60vh] px-4">
    <div class="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-8">
      <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </div>
    
    <h1 class="text-2xl font-semibold text-text mb-2">Something went wrong</h1>
    <p class="text-text-muted text-center max-w-md mb-6">
      We couldn't finish setting up your organization. Our team has been notified and will reach out shortly.
    </p>
    
    {#if error}
      <div class="bg-red-950/30 border border-red-800/50 rounded-lg px-4 py-3 max-w-lg">
        <p class="text-red-300 text-sm font-mono">{error}</p>
      </div>
    {/if}
    
    <div class="mt-8 text-text-dim text-sm">
      <p>Need help now? Contact us at <a href="mailto:support@yaffle.dev" class="text-yaffle-400 hover:underline">support@yaffle.dev</a></p>
    </div>
  </div>
{/if}
