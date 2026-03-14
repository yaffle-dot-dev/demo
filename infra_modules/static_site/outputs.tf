# =============================================================================
# Outputs
# =============================================================================
# site S3 bucket outputs.
# These are consumed by apps/infra/ for CloudFront configuration.
# =============================================================================

# -----------------------------------------------------------------------------
# Environment
# -----------------------------------------------------------------------------

output "environment" {
  value       = var.environment
  description = "The environment this infrastructure belongs to"
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

output "primary_bucket_regional_domain_name" {
  value       = aws_s3_bucket.primary.bucket_regional_domain_name
  description = "Primary S3 bucket regional domain name (for CloudFront origin)"
}

output "replica_bucket_name" {
  value       = aws_s3_bucket.replica.id
  description = "Replica S3 bucket name (us-west-2)"
}

output "replica_bucket_arn" {
  value       = aws_s3_bucket.replica.arn
  description = "Replica S3 bucket ARN"
}

output "replica_bucket_regional_domain_name" {
  value       = aws_s3_bucket.replica.bucket_regional_domain_name
  description = "Replica S3 bucket regional domain name (for CloudFront origin)"
}

# -----------------------------------------------------------------------------
# IAM Roles
# -----------------------------------------------------------------------------

output "deploy_role_arn" {
  value       = aws_iam_role.deploy.arn
  description = "IAM role ARN for GitHub Actions to deploy site"
}
