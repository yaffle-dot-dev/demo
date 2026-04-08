module "shared" {
  source = "${var.module_registry_host}/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

module "naming" {
  source      = "../../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

locals {
  is_preview = var.environment_kind == "transient"

  ai_gateway_id        = "yaffle-provider-discovery"
  worker_name          = "yaffle-provider-discovery-agent-${module.naming.suffix}"
  worker_host          = local.is_preview ? "provider-discovery-agent-${var.environment}.preview.${module.shared.domain}" : "provider-discovery-agent.${module.shared.domain}"
  worker_route_pattern = "${local.worker_host}/*"
}

resource "cloudflare_dns_record" "worker" {
  zone_id = module.shared.cloudflare_zone_id
  name    = local.worker_host
  type    = "A"
  content = "192.0.2.1"
  ttl     = 1
  proxied = true
}

resource "aws_secretsmanager_secret" "agent_token" {
  name        = "yaffle/${var.environment}/provider-discovery-agent/agent-token"
  description = "Provider discovery agent bearer token for ${var.environment}"

  tags = {
    Name      = "yaffle-provider-discovery-agent-token-${module.naming.suffix}"
    ManagedBy = "terraform"
  }
}

resource "aws_secretsmanager_secret" "callback_secret" {
  name        = "yaffle/${var.environment}/provider-discovery-agent/callback-secret"
  description = "Provider discovery callback signing secret for ${var.environment}"

  tags = {
    Name      = "yaffle-provider-discovery-callback-secret-${module.naming.suffix}"
    ManagedBy = "terraform"
  }
}

resource "aws_secretsmanager_secret" "github_token" {
  name        = "yaffle/${var.environment}/provider-discovery-agent/github-token"
  description = "Optional GitHub token for provider discovery research in ${var.environment}"

  tags = {
    Name      = "yaffle-provider-discovery-github-token-${module.naming.suffix}"
    ManagedBy = "terraform"
  }
}
