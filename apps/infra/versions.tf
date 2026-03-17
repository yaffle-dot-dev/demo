# =============================================================================
# Unified Frontend Infrastructure
# =============================================================================
# CloudFront distribution that routes:
# - /           -> Marketing site (Astro static)
# - /docs/*     -> Documentation site (Astro/Starlight)
# - /app/*      -> Web application (SvelteKit)
# - /api/*      -> Control plane ALB (future)
#
# Each app owns its S3 buckets; this module owns CloudFront + DNS + routing.
# Micro-sites (marketing, docs) use the local ./modules/micro_site module.
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Backend is injected by Yaffle via backend_override.tf
  # Do not add a backend block here - Yaffle manages state storage
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project     = "yaffle"
      layer       = "app"
      app         = "frontend"
      environment = var.environment
      managed_by  = "yaffle"
    }
  }
}

# Replica provider for cross-region bucket policies
provider "aws" {
  alias  = "replica"
  region = var.replica_region

  default_tags {
    tags = {
      project     = "yaffle"
      layer       = "app"
      app         = "frontend"
      environment = var.environment
      managed_by  = "yaffle"
    }
  }
}
