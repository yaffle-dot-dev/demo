# =============================================================================
# Outputs
# =============================================================================
# Web application infrastructure outputs.
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
# S3 Buckets
# -----------------------------------------------------------------------------

output "primary_bucket_name" {
  value       = aws_s3_bucket.primary.id
  description = "Primary S3 bucket name (us-east-1)"
}

output "primary_bucket_arn" {
  value       = aws_s3_bucket.primary.arn
  description = "Primary S3 bucket ARN"
}

output "replica_bucket_name" {
  value       = aws_s3_bucket.replica.id
  description = "Replica S3 bucket name (us-west-2)"
}

output "replica_bucket_arn" {
  value       = aws_s3_bucket.replica.arn
  description = "Replica S3 bucket ARN"
}

# -----------------------------------------------------------------------------
# URLs
# -----------------------------------------------------------------------------

output "site_url" {
  value       = "https://${local.site_domain}"
  description = "Website URL"
}

output "site_domain" {
  value       = local.site_domain
  description = "Website domain name"
}
