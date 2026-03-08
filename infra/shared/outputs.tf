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
