# =============================================================================
# Non-Production Infrastructure
# =============================================================================
# Non-production VPC and EC2-backed ECS cluster.
# Used for preview environments. Cost-optimized with spot instances.
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
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
      project     = "yaffle"
      layer       = "core"
      environment = "nonprod"
    }
  }
}
