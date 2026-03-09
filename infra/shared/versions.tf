# =============================================================================
# Shared Infrastructure
# =============================================================================
# True singletons - resources that exist once per AWS account/domain:
# - Route53 hosted zone for yaffle.dev
# - GitHub Actions OIDC provider
#
# These are never previewed. Deployed once manually or by bootstrap.
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Backend is injected by Yaffle via backend_override.tf
  # Do not add a backend block here - Yaffle manages state storage
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project = "yaffle"
      layer   = "shared"
    }
  }
}

# Cloudflare provider for dual DNS setup
# Authenticates via CLOUDFLARE_API_TOKEN env var
provider "cloudflare" {}
