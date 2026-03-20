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
