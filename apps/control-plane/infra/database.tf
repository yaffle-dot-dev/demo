# =============================================================================
# PlanetScale Postgres Database
# =============================================================================
# Per-environment branch of the shared PlanetScale database.
# The database itself is created out-of-band via `pscale db create`.
# Each environment gets its own branch and role (credentials).
# =============================================================================

locals {
  planetscale_org      = "yaffle"
  planetscale_database = "yaffle"
  # PlanetScale defaults regular branches to PS_DEV when cluster_size is omitted.
  planetscale_branch_size = local.is_preview ? null : "PS_5_AWS_ARM"
}

data "planetscale_database_postgres" "yaffle" {
  id           = local.planetscale_database
  organization = local.planetscale_org
}

# -----------------------------------------------------------------------------
# Branch - one per environment
# -----------------------------------------------------------------------------


import {
  for_each = local.import_main

  to = planetscale_postgres_branch.main
  id = jsonencode({
    organization = local.planetscale_org
    database     = data.planetscale_database_postgres.yaffle.name
    id           = var.environment
  })
}

resource "planetscale_postgres_branch" "main" {
  organization = local.planetscale_org
  database     = data.planetscale_database_postgres.yaffle.name
  name         = var.environment
  cluster_size = local.planetscale_branch_size
}

# -----------------------------------------------------------------------------
# Role - application credentials for this branch
# -----------------------------------------------------------------------------

resource "planetscale_postgres_branch_role" "app" {
  organization = local.planetscale_org
  database     = data.planetscale_database_postgres.yaffle.name
  branch       = planetscale_postgres_branch.main.name

  name = "yaffle-cp-${var.environment}"

  inherited_roles = ["pg_read_all_data", "pg_write_all_data"]
}

# -----------------------------------------------------------------------------
# Secrets Manager - DATABASE_URL for ECS task
# -----------------------------------------------------------------------------
# The ECS task definition already references:
#   ${local.secrets_arn_prefix}/database-url
# which resolves to yaffle/{environment}/database-url
# -----------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "database_url" {
  name        = "yaffle/${var.environment}/database-url"
  description = "PlanetScale Postgres connection string for ${var.environment}"

  tags = {
    Name                    = "yaffle-database-url-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.secrets
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${planetscale_postgres_branch_role.app.username}:${planetscale_postgres_branch_role.app.password}@${planetscale_postgres_branch_role.app.access_host_url}:5432/postgres?sslmode=require"
}
