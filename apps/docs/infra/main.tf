module "shared" {
  source = "yaffle.local:6969/yaffle-dot-dev/infra--shared/yaffle"
}

module "static_site" {
  source = "../../../infra_modules/static_site"

  site_name                = "docs"
  environment              = var.environment
  environment_kind         = var.environment_kind
  github_oidc_provider_arn = module.shared.github_actions_oidc_provider_arn
}
