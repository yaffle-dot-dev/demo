output "environment" {
  value       = var.environment
  description = "The environment this infrastructure belongs to"
}

output "worker_name" {
  value       = local.worker_name
  description = "Cloudflare Worker script name for this environment"
}

output "worker_host" {
  value       = local.worker_host
  description = "Custom hostname for this Worker deployment"
}

output "worker_route_pattern" {
  value       = local.worker_route_pattern
  description = "Cloudflare route pattern that should be attached during deploy"
}

output "worker_url" {
  value       = "https://${local.worker_host}"
  description = "Base URL for the provider discovery worker"
}

output "dns_record_id" {
  value       = cloudflare_dns_record.worker.id
  description = "Cloudflare DNS record ID backing the worker hostname"
}

output "cloudflare_account_id_secret_id" {
  value       = "yaffle/shared/cloudflare/account-id"
  description = "Secrets Manager secret ID containing the Cloudflare account ID for deploys"
}

output "cloudflare_api_token_secret_id" {
  value       = "yaffle/shared/cloudflare/api-token"
  description = "Secrets Manager secret ID containing the Cloudflare API token for deploys"
}

output "agent_token_secret_id" {
  value       = aws_secretsmanager_secret.agent_token.name
  description = "Secrets Manager secret ID containing the provider discovery agent bearer token"
}

output "callback_secret_secret_id" {
  value       = aws_secretsmanager_secret.callback_secret.name
  description = "Secrets Manager secret ID containing the provider discovery callback secret"
}

output "github_token_secret_id" {
  value       = aws_secretsmanager_secret.github_token.name
  description = "Secrets Manager secret ID containing the optional GitHub token for provider research"
}
