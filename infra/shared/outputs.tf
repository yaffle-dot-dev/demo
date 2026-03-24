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
