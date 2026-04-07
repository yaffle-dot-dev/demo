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
# Stripe Webhook Endpoint
# =============================================================================
# Receives billing lifecycle events from Stripe.
# URL is variable — Smee proxy for dev, public URL for prod.
# The signing secret is exported by the resource (no manual management).
# =============================================================================

resource "stripe_webhook_endpoint" "billing" {
  url         = var.stripe_webhook_url
  description = "Yaffle billing webhook endpoint"

  enabled_events = [
    "checkout.session.completed",
    "invoice.paid",
    "invoice.payment_failed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]
}

# =============================================================================
# Stripe Customer Portal
# =============================================================================
# Self-service portal for customers to manage payment methods, view invoices,
# and cancel/update subscriptions. Hosted by Stripe.
# =============================================================================

resource "stripe_portal_configuration" "default" {
  active             = true
  default_return_url = var.yaffle_app_url

  business_profile {
    headline = "Manage your Yaffle subscription"
  }

  features {
    invoice_history {
      enabled = true
    }

    payment_method_update {
      enabled = true
    }

    subscription_cancel {
      enabled            = true
      mode               = "at_period_end"
      proration_behavior = "none"

      cancellation_reason {
        enabled = false
        options = [
          "too_expensive",
          "missing_features",
          "switched_service",
          "unused",
          "other",
        ]
      }
    }

    subscription_update {
      enabled                 = true
      default_allowed_updates = ["price"]
      proration_behavior      = "create_prorations"

      products {
        product = stripe_product.pro.id
        prices  = [stripe_price.pro_monthly.id]
      }

      products {
        product = stripe_product.team.id
        prices  = [stripe_price.team_monthly.id]
      }
    }
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
    Name                    = "yaffle-shared-stripe-api-key"
    ManagedBy               = "terraform"
    "yaffle:resource-class" = local.shared_resource_classes.secrets
  }
}

resource "aws_secretsmanager_secret" "stripe_webhook_signing_secret" {
  name        = "yaffle/shared/stripe/webhook-signing-secret"
  description = "Stripe webhook signing secret for verifying webhook payloads"

  tags = {
    Name                    = "yaffle-shared-stripe-webhook-signing-secret"
    ManagedBy               = "terraform"
    "yaffle:resource-class" = local.shared_resource_classes.secrets
  }
}

# Auto-populate from the Stripe webhook endpoint
resource "aws_secretsmanager_secret_version" "stripe_webhook_signing_secret" {
  secret_id     = aws_secretsmanager_secret.stripe_webhook_signing_secret.id
  secret_string = stripe_webhook_endpoint.billing.secret
}

# API key: value set via CLI (terraform uses it to authenticate, can't self-reference).
# Seed with placeholder so ECS tasks don't fail on missing version.
resource "aws_secretsmanager_secret_version" "stripe_api_key" {
  secret_id     = aws_secretsmanager_secret.stripe_api_key.id
  secret_string = "PLACEHOLDER-set-via-cli"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
