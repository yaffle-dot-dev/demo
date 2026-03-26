# =============================================================================
# Stripe Secrets
# =============================================================================
# Secret shells managed by Terraform, values populated via CLI/console.
# The Stripe provider authenticates via STRIPE_API_KEY env var (connection).
# =============================================================================

# =============================================================================
# Stripe Products & Prices
# =============================================================================
# Product catalog managed as code. Prices are the source of truth for billing
# amounts — consumed by the control plane and marketing site via outputs.
#
# Free tier has no Stripe product (enforced by control plane limits).
# =============================================================================

resource "stripe_product" "pro" {
  name        = "Yaffle Pro"
  description = "Unlimited previews, environments, and approval workflows for growing teams."
  active      = true

  metadata = {
    plan_tier = "pro"
  }
}

resource "stripe_price" "pro_monthly" {
  product     = stripe_product.pro.id
  currency    = "usd"
  unit_amount = 9900 # $99.00
  nickname    = "Pro Monthly"

  recurring {
    interval       = "month"
    interval_count = 1
    usage_type     = "licensed"
  }

  metadata = {
    plan_tier = "pro"
  }
}

resource "stripe_product" "team" {
  name        = "Yaffle Team"
  description = "Everything in Pro plus SSO, BYOA runners, audit logs, and priority support."
  active      = true

  metadata = {
    plan_tier = "team"
  }
}

resource "stripe_price" "team_monthly" {
  product     = stripe_product.team.id
  currency    = "usd"
  unit_amount = 29900 # $299.00
  nickname    = "Team Monthly"

  recurring {
    interval       = "month"
    interval_count = 1
    usage_type     = "licensed"
  }

  metadata = {
    plan_tier = "team"
  }
}

# =============================================================================
# Stripe Secrets
# =============================================================================
# Secret shells managed by Terraform, values populated via CLI/console.
# The Stripe provider authenticates via STRIPE_API_KEY env var (connection).
# =============================================================================

resource "aws_secretsmanager_secret" "stripe_api_key" {
  name        = "yaffle/shared/stripe/api-key"
  description = "Stripe API secret key for the control plane"

  tags = {
    Name      = "yaffle-shared-stripe-api-key"
    ManagedBy = "terraform"
  }
}

resource "aws_secretsmanager_secret" "stripe_webhook_signing_secret" {
  name        = "yaffle/shared/stripe/webhook-signing-secret"
  description = "Stripe webhook signing secret for verifying webhook payloads"

  tags = {
    Name      = "yaffle-shared-stripe-webhook-signing-secret"
    ManagedBy = "terraform"
  }
}
