# =============================================================================
# Micro Site Module Outputs
# =============================================================================
# Configuration objects for the main CloudFront distribution.
# =============================================================================

output "origin_access_control_id" {
  value       = aws_cloudfront_origin_access_control.this.id
  description = "Origin Access Control ID for S3 buckets"
}

output "primary_origin_id" {
  value       = "${var.site_name}-primary"
  description = "Origin ID for primary S3 bucket"
}

output "replica_origin_id" {
  value       = "${var.site_name}-replica"
  description = "Origin ID for replica S3 bucket"
}

output "failover_origin_id" {
  value       = "${var.site_name}-failover"
  description = "Origin group ID for failover"
}

output "primary_bucket_domain" {
  value       = var.primary_bucket_domain
  description = "Primary S3 bucket domain"
}

output "replica_bucket_domain" {
  value       = var.replica_bucket_domain
  description = "Replica S3 bucket domain"
}

output "site_name" {
  value       = var.site_name
  description = "Site name"
}

output "path_pattern" {
  value       = var.path_pattern
  description = "Path pattern for ordered cache behavior"
}

output "is_default" {
  value       = var.is_default
  description = "Whether this is the default cache behavior"
}

output "immutable_path_pattern" {
  value       = var.immutable_path_pattern
  description = "Path pattern for immutable assets"
}
