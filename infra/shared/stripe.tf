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
