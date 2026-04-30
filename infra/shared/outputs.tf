# =============================================================================
# Shared Infrastructure Outputs
# =============================================================================
# True singletons: Route53 zone, GitHub OIDC provider
# These are never previewed - only one per AWS account/domain.
# =============================================================================

output "route53_zone_id" {
  value       = aws_route53_zone.main.zone_id
  description = "Route53 hosted zone ID"
}

output "route53_nameservers" {
  value       = aws_route53_zone.main.name_servers
  description = "Route53 nameservers - update your registrar to use these"
}

output "domain" {
  value       = var.domain
  description = "Base domain"
}

output "cloudflare_zone_id" {
  value       = var.cloudflare_zone_id
  description = "Cloudflare zone ID for the primary domain"
}

output "cloudflare_account_id_secret_arn" {
  value       = aws_secretsmanager_secret.cloudflare_account_id.arn
  description = "Secrets Manager ARN for the Cloudflare account ID"
}

output "cloudflare_api_token_secret_arn" {
  value       = aws_secretsmanager_secret.cloudflare_api_token.arn
  description = "Secrets Manager ARN for the Cloudflare API token"
}

output "github_actions_yaffle_api_token_secret_arn" {
  value       = aws_secretsmanager_secret.github_actions_yaffle_api_token.arn
  description = "Secrets Manager ARN for the Yaffle API token used by GitHub Actions"
}

# -----------------------------------------------------------------------------
# Hookdeck
# -----------------------------------------------------------------------------

output "hookdeck_api_key_secret_arn" {
  value       = aws_secretsmanager_secret.hookdeck_api_key.arn
  description = "Secrets Manager ARN for the Hookdeck API key"
}

output "hookdeck_webhook_secret_arn" {
  value       = aws_secretsmanager_secret.hookdeck_webhook_secret.arn
  description = "Secrets Manager ARN for the Hookdeck webhook signing secret"
}

output "hookdeck_github_source_id" {
  value       = hookdeck_source.github_app.id
  description = "Hookdeck source ID for the GitHub App ingress"
}

output "hookdeck_github_source_name" {
  value       = local.hookdeck_github_source_name
  description = "Hookdeck source name for the GitHub App ingress"
}

output "hookdeck_github_source_url" {
  value       = hookdeck_source.github_app.url
  description = "Hookdeck source URL to configure as the GitHub App webhook endpoint"
}

output "hookdeck_production_destination_id" {
  value       = hookdeck_destination.control_plane.id
  description = "Hookdeck destination ID for the production control-plane receiver"
}

output "hookdeck_production_destination_name" {
  value       = local.hookdeck_production_destination_name
  description = "Hookdeck destination name for the production control-plane receiver"
}

output "hookdeck_production_connection_name" {
  value       = local.hookdeck_production_connection_name
  description = "Hookdeck connection name reserved for the production delivery path"
}

# -----------------------------------------------------------------------------
# Stripe
# -----------------------------------------------------------------------------

output "stripe_api_key_secret_arn" {
  value       = aws_secretsmanager_secret.stripe_api_key.arn
  description = "Secrets Manager ARN for the Stripe API key"
}

output "stripe_webhook_signing_secret_arn" {
  value       = aws_secretsmanager_secret.stripe_webhook_signing_secret.arn
  description = "Secrets Manager ARN for the Stripe webhook signing secret"
}

output "stripe_webhook_signing_secret" {
  value       = stripe_webhook_endpoint.billing.secret
  description = "Stripe webhook signing secret for verifying payloads"
  sensitive   = true
}

output "stripe_portal_configuration_id" {
  value       = stripe_portal_configuration.default.id
  description = "Stripe Customer Portal configuration ID"
}

output "stripe_pricing" {
  value = {
    pro = {
      product_id = stripe_product.pro.id
      price_id   = stripe_price.pro_monthly.id
      amount     = stripe_price.pro_monthly.unit_amount / 100
      interval   = "month"
    }
    team = {
      product_id = stripe_product.team.id
      price_id   = stripe_price.team_monthly.id
      amount     = stripe_price.team_monthly.unit_amount / 100
      interval   = "month"
    }
    free_limits = {
      concurrent_preview_branches = 5
      preview_creations_per_month = 25
      named_environments          = 1
    }
  }
  description = "Stripe pricing data — consumed by control plane and marketing site"
}

# -----------------------------------------------------------------------------
# GitHub Actions OIDC
# -----------------------------------------------------------------------------

output "github_actions_ci_role_arn" {
  value       = aws_iam_role.github_actions_ci.arn
  description = "IAM role ARN for GitHub Actions CI to assume"
}

output "github_actions_oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.github_actions.arn
  description = "GitHub Actions OIDC provider ARN"
}

# -----------------------------------------------------------------------------
# Depot CI OIDC
# -----------------------------------------------------------------------------

output "depot_ci_role_arn" {
  value       = aws_iam_role.depot_ci.arn
  description = "IAM role ARN for Depot CI to assume"
}

output "depot_oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.depot.arn
  description = "Depot OIDC provider ARN"
}

output "site_deployer_role_arn" {
  value       = aws_iam_role.site_deployer.arn
  description = "IAM role ARN for human site deployers"
}

output "docs_deployer_role_arn" {
  value       = aws_iam_role.docs_deployer.arn
  description = "IAM role ARN for human docs deployers"
}

output "app_deployer_role_arn" {
  value       = aws_iam_role.app_deployer.arn
  description = "IAM role ARN for human app deployers"
}

output "self_hosted_main_execution_role_arn" {
  value       = module.self_hosted_main_execution_role.role_arn
  description = "IAM role ARN for Yaffle's dogfood main execution role"
}

output "self_hosted_non_main_execution_role_arn" {
  value       = module.self_hosted_non_main_execution_role.role_arn
  description = "IAM role ARN for Yaffle's dogfood non-main execution role"
}

output "self_hosted_non_main_execution_guardrail_policy_arns" {
  value = [
    aws_iam_policy.self_hosted_non_main_write_scope_guardrails.arn,
    aws_iam_policy.self_hosted_non_main_create_scope_guardrails.arn,
    aws_iam_policy.self_hosted_non_main_sensitive_guardrails.arn,
  ]
  description = "Managed policy ARNs that guard non-main Yaffle execution roles"
}

# -----------------------------------------------------------------------------
# ACM Certificate
# -----------------------------------------------------------------------------

output "acm_certificate_arn" {
  value       = aws_acm_certificate.main.arn
  description = "ARN of the wildcard ACM certificate for yaffle.dev"
}

output "acm_certificate_validated_arn" {
  value       = aws_acm_certificate_validation.main.certificate_arn
  description = "ARN of the validated ACM certificate (use this for ALB listeners)"
}

# -----------------------------------------------------------------------------
# Tailscale
# -----------------------------------------------------------------------------

output "tailscale_layer_ssm_parameter_arn" {
  value       = aws_ssm_parameter.tailscale_layer_arn.arn
  description = "SSM parameter ARN for the current scanner Tailscale Lambda layer"
}

output "tailscale_runner_authkey_secret_arn" {
  value       = aws_secretsmanager_secret.tailscale_runner_authkey.arn
  description = "Secrets Manager ARN for the ECS runner Tailscale auth secret"
}

output "tailscale_runner_oauth_client_id" {
  value       = tailscale_oauth_client.ecs_runner.id
  description = "Tailscale OAuth client ID for ECS runners"
}

output "tailscale_github_actions_oauth_client_id" {
  value       = tailscale_oauth_client.github_actions.id
  description = "Tailscale OAuth client ID for GitHub Actions ephemeral CI nodes"
}

output "tailscale_github_actions_oauth_secret_arn" {
  value       = aws_secretsmanager_secret.tailscale_github_actions_oauth.arn
  description = "Secrets Manager ARN for the GitHub Actions Tailscale OAuth credentials"
}
