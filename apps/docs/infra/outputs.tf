# Re-export static_site module outputs

output "environment" {
  value       = module.static_site.environment
  description = "The environment this infrastructure belongs to"
}

output "primary_bucket_name" {
  value       = module.static_site.primary_bucket_name
  description = "Primary S3 bucket name (us-east-1)"
}

output "primary_bucket_arn" {
  value       = module.static_site.primary_bucket_arn
  description = "Primary S3 bucket ARN"
}

output "primary_bucket_regional_domain_name" {
  value       = module.static_site.primary_bucket_regional_domain_name
  description = "Primary S3 bucket regional domain name (for CloudFront origin)"
}

output "replica_bucket_name" {
  value       = module.static_site.replica_bucket_name
  description = "Replica S3 bucket name (us-west-2)"
}

output "replica_bucket_arn" {
  value       = module.static_site.replica_bucket_arn
  description = "Replica S3 bucket ARN"
}

output "replica_bucket_regional_domain_name" {
  value       = module.static_site.replica_bucket_regional_domain_name
  description = "Replica S3 bucket regional domain name (for CloudFront origin)"
}

output "deploy_role_arn" {
  value       = module.static_site.deploy_role_arn
  description = "IAM role ARN for GitHub Actions to deploy site"
}
