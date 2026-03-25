module "shared" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

module "static_site" {
  source = "../../../infra_modules/static_site"

  site_name                = "docs"
  environment              = var.environment
  environment_kind         = var.environment_kind
  github_oidc_provider_arn = module.shared.github_actions_oidc_provider_arn
  depot_oidc_provider_arn  = module.shared.depot_oidc_provider_arn
}

variable "environment" {
  type        = string
  description = "Environment name - branch name (e.g., 'main') or preview (e.g., 'prvw-42')"
}

variable "environment_kind" {
  type        = string
  description = "Kind of environment ('named' or 'transient')"
}
