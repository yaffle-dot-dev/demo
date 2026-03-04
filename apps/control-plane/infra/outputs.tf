# =============================================================================
# Outputs
# =============================================================================
# These outputs are consumed by:
# - The control plane API (to configure S3 backend for user workspaces)
# - CI pipelines (via yaffle-dev/outputs-action)
# - Other infrastructure that depends on state storage
# =============================================================================

output "environment" {
  value       = var.environment
  description = "The environment this infrastructure belongs to"
}

output "state_bucket_name" {
  value       = aws_s3_bucket.state.id
  description = "S3 bucket name for terraform state storage"
}

output "state_bucket_arn" {
  value       = aws_s3_bucket.state.arn
  description = "S3 bucket ARN for IAM policies"
}

output "lock_table_name" {
  value       = aws_dynamodb_table.locks.name
  description = "DynamoDB table name for state locking"
}

output "lock_table_arn" {
  value       = aws_dynamodb_table.locks.arn
  description = "DynamoDB table ARN for IAM policies"
}

output "aws_region" {
  value       = var.aws_region
  description = "AWS region where resources are deployed"
}
