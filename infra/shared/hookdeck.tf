# =============================================================================
# Hookdeck GitHub App Webhook Ingress
# =============================================================================
# Hookdeck fronts the GitHub App webhook URL so production remains the default
# destination while preview-specific routing can be layered on later.
#
# Phase 1 intentionally does not configure Hookdeck source verification for the
# GitHub secret. Yaffle still verifies the original GitHub signature on
# forwarded requests, which avoids persisting the GitHub webhook secret in
# Terraform state.
# =============================================================================

locals {
  hookdeck_webhook_url                 = "https://api.${var.domain}/api/webhooks/github"
  hookdeck_github_source_name          = "yaffle-github-app"
  hookdeck_production_destination_name = "yaffle-control-plane-${var.environment}"
  hookdeck_production_connection_name  = "github-app-to-control-plane-${var.environment}"
}

resource "aws_secretsmanager_secret" "hookdeck_api_key" {
  name        = "yaffle/shared/hookdeck/api-key"
  description = "Hookdeck API key for managing Yaffle webhook ingress"

  tags = {
    Name                    = "yaffle-shared-hookdeck-api-key"
    ManagedBy               = "terraform"
    "yaffle:resource-class" = local.shared_resource_classes.secrets
  }
}

resource "aws_secretsmanager_secret_version" "hookdeck_api_key" {
  secret_id     = aws_secretsmanager_secret.hookdeck_api_key.id
  secret_string = "PLACEHOLDER-set-via-cli"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "hookdeck_webhook_secret" {
  name        = "yaffle/shared/hookdeck/webhook-secret"
  description = "Hookdeck project signing secret for verifying forwarded webhook deliveries"

  tags = {
    Name                    = "yaffle-shared-hookdeck-webhook-secret"
    ManagedBy               = "terraform"
    "yaffle:resource-class" = local.shared_resource_classes.secrets
  }
}

resource "aws_secretsmanager_secret_version" "hookdeck_webhook_secret" {
  secret_id     = aws_secretsmanager_secret.hookdeck_webhook_secret.id
  secret_string = "PLACEHOLDER-set-via-cli"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "hookdeck_source" "github_app" {
  name        = local.hookdeck_github_source_name
  type        = "GITHUB"
  description = "GitHub App webhook ingress for Yaffle"
}

resource "hookdeck_destination" "control_plane" {
  name        = local.hookdeck_production_destination_name
  type        = "HTTP"
  description = "Yaffle control-plane GitHub webhook receiver"
  config = jsonencode({
    url = local.hookdeck_webhook_url
  })
}
