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
}

# -----------------------------------------------------------------------------
# Branch - one per environment
# -----------------------------------------------------------------------------

resource "planetscale_postgres_branch" "main" {
  organization  = local.planetscale_org
  database      = local.planetscale_database
  name          = var.environment
  region        = var.aws_region
  cluster_size  = "PS_5_AWS_ARM"
  major_version = "18.3"
}

# -----------------------------------------------------------------------------
# Role - application credentials for this branch
# -----------------------------------------------------------------------------

resource "planetscale_postgres_branch_role" "app" {
  organization    = local.planetscale_org
  database        = local.planetscale_database
  branch          = planetscale_postgres_branch.main.name
  name            = "yaffle-cp-${var.environment}"
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
    Name = "yaffle-database-url-${local.name_suffix}"
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${planetscale_postgres_branch_role.app.username}:${planetscale_postgres_branch_role.app.password}@${planetscale_postgres_branch_role.app.access_host_url}/${planetscale_postgres_branch_role.app.database_name}?sslmode=require"
}
