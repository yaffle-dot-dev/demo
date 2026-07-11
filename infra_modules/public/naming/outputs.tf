output "suffix" {
  description = "Resource name suffix: {environment}-{region_short} (e.g. 'main-use1', 'pr-42-usw2')"
  value       = local.suffix
}

output "environment" {
  description = "Environment name passed through for convenience"
  value       = var.environment
}

output "region_short" {
  description = "Short region code (e.g. 'use1' for us-east-1)"
  value       = local.region_short
}
