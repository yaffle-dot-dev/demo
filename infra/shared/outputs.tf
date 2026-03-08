# =============================================================================
# Shared Infrastructure Outputs
# =============================================================================

output "state_bucket_name" {
  value       = aws_s3_bucket.state.id
  description = "S3 bucket name for terraform state storage"
}

output "state_bucket_arn" {
  value       = aws_s3_bucket.state.arn
  description = "S3 bucket ARN for IAM policies"
}

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

output "aws_region" {
  value       = var.aws_region
  description = "AWS region"
}

output "region_short" {
  value       = local.region_short
  description = "Abbreviated region code (e.g., use1)"
}

output "environment" {
  value       = var.environment
  description = "Environment name"
}

output "name_suffix" {
  value       = local.name_suffix
  description = "Standard naming suffix ({env}-{region})"
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
