# =============================================================================
# Marketing Site S3 Bucket
# =============================================================================
# S3 bucket for the Astro marketing site static assets.
# CloudFront distribution is managed in apps/infra/ for unified routing.
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
      app         = "marketing"
      environment = var.environment
      managed_by  = "yaffle"
    }
  }
}

# Replica provider for cross-region S3 bucket replication
provider "aws" {
  alias  = "replica"
  region = var.replica_region

  default_tags {
    tags = {
      project     = "yaffle"
      layer       = "app"
      app         = "marketing"
      environment = var.environment
      managed_by  = "yaffle"
    }
  }
}
