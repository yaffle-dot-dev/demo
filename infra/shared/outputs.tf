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

output "lock_table_name" {
  value       = aws_dynamodb_table.locks.name
  description = "DynamoDB table name for state locking"
}

output "lock_table_arn" {
  value       = aws_dynamodb_table.locks.arn
  description = "DynamoDB table ARN for IAM policies"
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
