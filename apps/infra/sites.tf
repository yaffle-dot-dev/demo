# =============================================================================
# Micro Sites Configuration
# =============================================================================
# Instantiate the micro_site module for each static site behind yaffle.dev.
# Each module generates CloudFront origins and OAC.
#
# Sites are expected to build with their path prefix baked in:
# - Marketing builds to / (root)
# - Docs builds to /docs/
# =============================================================================

# -----------------------------------------------------------------------------
# Marketing Site (/)
# -----------------------------------------------------------------------------

module "site_marketing" {
  source = "./modules/micro_site"

  site_name              = "marketing"
  is_default             = true
  immutable_path_pattern = "_astro/*"

  primary_bucket_domain = local.marketing_primary_bucket_domain
  replica_bucket_domain = local.marketing_replica_bucket_domain
  name_suffix           = local.name_suffix
}

# -----------------------------------------------------------------------------
# Docs Site (/docs/*)
# -----------------------------------------------------------------------------

module "site_docs" {
  source = "./modules/micro_site"

  site_name              = "docs"
  path_pattern           = "/docs/*"
  immutable_path_pattern = "/docs/_astro/*"

  primary_bucket_domain = local.docs_primary_bucket_domain
  replica_bucket_domain = local.docs_replica_bucket_domain
  name_suffix           = local.name_suffix
}
