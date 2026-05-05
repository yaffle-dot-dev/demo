# =============================================================================
# Secrets Manager - Application Secrets
# =============================================================================
# These secrets are created by terraform but their VALUES are managed
# out-of-band (manually or via CI). Terraform ensures the secrets exist
# so ECS tasks can reference them. Use the AWS CLI to set values:
#
#   aws secretsmanager put-secret-value \
#     --secret-id yaffle/main/github-app-id \
#     --secret-string "YOUR_VALUE"
# =============================================================================

locals {
  # Secrets that need to exist for the CP to start.
  # database-url is managed in database.tf (value from PlanetScale).
  # Stripe secrets are managed in infra/shared.
  app_secrets = {
    github-app-id              = "GitHub App ID"
    github-app-private-key     = "GitHub App private key (PEM)"
    github-webhook-secret      = "GitHub webhook HMAC secret"
    local-first-feature-token  = "Local-first backend feature token"
    better-auth-secret         = "BetterAuth encryption secret (32+ chars)"
    github-oauth-client-id     = "GitHub OAuth app client ID"
    github-oauth-client-secret = "GitHub OAuth app client secret"
    otel-headers               = "OpenTelemetry exporter headers (e.g., Authorization=Bearer xxx,X-Axiom-Dataset=yaffle)"
    otel-metrics-headers       = "OpenTelemetry metrics exporter headers (e.g., Authorization=Bearer xxx,X-Axiom-Dataset=yaffle)"
    otel-traces-headers        = "OpenTelemetry traces exporter headers (e.g., Authorization=Bearer xxx,X-Axiom-Dataset=yaffle)"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.app_secrets

  name        = "yaffle/${var.environment}/${each.key}"
  description = "${each.value} for ${var.environment}"

  tags = {
    Name                    = "yaffle-${each.key}-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.secrets
  }
}

# Seed with a placeholder so the secret version exists (ECS fails if there's
# no version at all). Replace with real values via CLI before first deploy.
resource "aws_secretsmanager_secret_version" "app_placeholder" {
  for_each = local.app_secrets

  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = "PLACEHOLDER-set-via-cli"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
