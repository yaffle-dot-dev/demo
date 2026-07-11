<script lang="ts">
  import { page } from "$app/state"
  import { onMount } from "svelte"
  import { listOrgs, createCheckoutSession, createPortalSession } from "$lib/api"
  import { useSession } from "$lib/auth"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import ActionButton from "$lib/components/ActionButton.svelte"
  import { env } from "$env/dynamic/public"

  const org = $derived(page.params.org ?? "")
  const session = useSession()

  // Pricing from env vars (injected from Terraform outputs at runtime)
  const PRO_PRICE_ID = $derived(env.PUBLIC_STRIPE_PRO_PRICE_ID ?? "")
  const PRO_AMOUNT = $derived(Number(env.PUBLIC_STRIPE_PRO_AMOUNT ?? "99"))
  const TEAM_PRICE_ID = $derived(env.PUBLIC_STRIPE_TEAM_PRICE_ID ?? "")
  const TEAM_AMOUNT = $derived(Number(env.PUBLIC_STRIPE_TEAM_AMOUNT ?? "299"))

  let planTier = $state<string>("free")
  let subscriptionStatus = $state<string>("none")
  let loading = $state(true)
  let checkoutLoading = $state(false)
  let portalLoading = $state(false)
  let error = $state<string | null>(null)

  const isActive = $derived(subscriptionStatus === "active" || subscriptionStatus === "trialing")
  const isPastDue = $derived(subscriptionStatus === "past_due")
  const isFree = $derived(planTier === "free")

  async function load() {
    loading = true
    try {
      const res = await listOrgs()
      const orgData = res.data.find((o) => o.slug === org)
      if (orgData) {
        planTier = (orgData as any).planTier ?? "free"
        subscriptionStatus = (orgData as any).subscriptionStatus ?? "none"
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function handleCheckout(priceId: string) {
    checkoutLoading = true
    error = null
    try {
      const res = await createCheckoutSession(org, { priceId })
      if (res.data.url) {
        window.location.href = res.data.url
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      checkoutLoading = false
    }
  }

  async function handlePortal() {
    portalLoading = true
    error = null
    try {
      const res = await createPortalSession(org)
      if (res.data.url) {
        window.location.href = res.data.url
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      portalLoading = false
    }
  }

  let hasLoaded = false
  onMount(() => {
    const unsubscribe = session.subscribe((state) => {
      if (state.isPending) return
      if (hasLoaded) return
      hasLoaded = true
      if (!state.data?.user) { goto(`${base}/`); return }
      load()
    })
    return unsubscribe
  })

  // Check for checkout result in URL
  const checkoutResult = $derived(page.url.searchParams.get("checkout"))
</script>

<section class="space-y-2 border-b border-border pb-6">
  <h2 class="text-2xl font-semibold text-text">Billing</h2>
  <p class="text-sm text-text-muted">
    Manage your subscription and payment details.
  </p>
</section>

{#if checkoutResult === "success"}
  <div class="text-sm text-green-400 bg-green-400/10 rounded-lg px-3 py-2">
    Subscription activated! Your plan has been upgraded.
  </div>
{:else if checkoutResult === "canceled"}
  <div class="text-sm text-text-muted bg-surface-raised rounded-lg px-3 py-2">
    Checkout was canceled. No changes were made.
  </div>
{/if}

{#if error}
  <div class="text-sm text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
    {error}
  </div>
{/if}

{#if loading}
  <div class="text-sm text-text-muted py-8 text-center">Loading billing info...</div>
{:else}
  <!-- Current plan -->
  <div class="rounded-xl border border-border bg-surface-raised p-5 space-y-3">
    <div class="flex items-center justify-between">
      <div>
        <div class="text-sm text-text-dim">Current plan</div>
        <div class="text-lg font-semibold text-text capitalize">{planTier}</div>
        {#if isPastDue}
          <div class="text-sm text-amber-400 mt-1">Payment past due — please update your payment method.</div>
        {/if}
      </div>
      {#if isActive || isPastDue}
        <ActionButton onclick={handlePortal} disabled={portalLoading}>
          {portalLoading ? "Loading..." : "Manage billing"}
        </ActionButton>
      {/if}
    </div>
  </div>

  <!-- Plan comparison -->
  <div class="grid gap-4 md:grid-cols-3">
    <!-- Free -->
    <div class="rounded-xl border {isFree ? 'border-yaffle-500' : 'border-border'} bg-surface p-5 space-y-4">
      <div>
        <div class="text-lg font-semibold text-text">Free</div>
        <div class="text-2xl font-bold text-text mt-1">$0<span class="text-sm font-normal text-text-dim">/month</span></div>
      </div>
      <ul class="space-y-2 text-sm text-text-muted">
        <li>5 concurrent preview branches</li>
        <li>25 preview creations/month</li>
        <li>1 named environment</li>
        <li>Unlimited repos & workspaces</li>
        <li>Unlimited seats</li>
      </ul>
      {#if isFree}
        <div class="text-sm text-yaffle-400 font-medium text-center py-2">Current plan</div>
      {/if}
    </div>

    <!-- Pro -->
    <div class="rounded-xl border {planTier === 'pro' ? 'border-yaffle-500' : 'border-border'} bg-surface p-5 space-y-4">
      <div>
        <div class="text-lg font-semibold text-text">Pro</div>
        <div class="text-2xl font-bold text-text mt-1">${PRO_AMOUNT}<span class="text-sm font-normal text-text-dim">/month</span></div>
      </div>
      <ul class="space-y-2 text-sm text-text-muted">
        <li>Unlimited preview branches</li>
        <li>Unlimited preview creations</li>
        <li>Unlimited named environments</li>
        <li>Approval workflows</li>
        <li>Everything in Free</li>
      </ul>
      {#if planTier === "pro"}
        <div class="text-sm text-yaffle-400 font-medium text-center py-2">Current plan</div>
      {:else if isFree && PRO_PRICE_ID}
        <ActionButton onclick={() => handleCheckout(PRO_PRICE_ID)} disabled={checkoutLoading}>
          {checkoutLoading ? "Loading..." : "Upgrade to Pro"}
        </ActionButton>
      {/if}
    </div>

    <!-- Team -->
    <div class="rounded-xl border {planTier === 'team' ? 'border-yaffle-500' : 'border-border'} bg-surface p-5 space-y-4">
      <div>
        <div class="text-lg font-semibold text-text">Team</div>
        <div class="text-2xl font-bold text-text mt-1">${TEAM_AMOUNT}<span class="text-sm font-normal text-text-dim">/month</span></div>
      </div>
      <ul class="space-y-2 text-sm text-text-muted">
        <li>Everything in Pro</li>
        <li>Shared team workflows</li>
        <li>Organization member management</li>
        <li>Named environment history</li>
        <li>Usage and billing dashboard</li>
      </ul>
      {#if planTier === "team"}
        <div class="text-sm text-yaffle-400 font-medium text-center py-2">Current plan</div>
      {:else if TEAM_PRICE_ID}
        <ActionButton onclick={() => handleCheckout(TEAM_PRICE_ID)} disabled={checkoutLoading}>
          {checkoutLoading ? "Loading..." : "Upgrade to Team"}
        </ActionButton>
      {/if}
    </div>
  </div>
{/if}
