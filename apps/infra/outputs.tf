# =============================================================================
# Outputs
# =============================================================================
# Unified frontend infrastructure outputs.
# =============================================================================

# -----------------------------------------------------------------------------
# Environment
# -----------------------------------------------------------------------------

output "environment" {
  value       = var.environment
  description = "The environment this infrastructure belongs to"
}

# -----------------------------------------------------------------------------
# CloudFront
# -----------------------------------------------------------------------------

output "cloudfront_distribution_id" {
  value       = aws_cloudfront_distribution.main.id
  description = "CloudFront distribution ID"
}

output "cloudfront_distribution_arn" {
  value       = aws_cloudfront_distribution.main.arn
  description = "CloudFront distribution ARN"
}

output "cloudfront_domain_name" {
  value       = aws_cloudfront_distribution.main.domain_name
  description = "CloudFront distribution domain name"
}

# -----------------------------------------------------------------------------
# URLs
# -----------------------------------------------------------------------------

output "site_url" {
  value       = "https://${local.site_domain}"
  description = "Website URL (root)"
}

output "site_domain" {
  value       = local.site_domain
  description = "Website domain name"
}

output "marketing_url" {
  value       = "https://${local.site_domain}/"
  description = "Marketing site URL"
}

output "docs_url" {
  value       = "https://${local.site_domain}/docs/"
  description = "Documentation site URL"
}

output "api_url" {
  value       = "https://${local.site_domain}/api/"
  description = "Control plane API URL (via CloudFront)"
}

# -----------------------------------------------------------------------------
# S3 Buckets (from app modules)
# -----------------------------------------------------------------------------

output "marketing_bucket_name" {
  value       = module.marketing.primary_bucket_name
  description = "Marketing site S3 bucket name"
}

output "docs_bucket_name" {
  value       = module.docs.primary_bucket_name
  description = "Docs site S3 bucket name"
}

# -----------------------------------------------------------------------------
# IAM Roles
# -----------------------------------------------------------------------------

output "invalidation_role_arn" {
  value       = aws_iam_role.invalidation.arn
  description = "IAM role ARN for GitHub Actions to invalidate CloudFront cache"
}
