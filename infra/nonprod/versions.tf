# =============================================================================
# Non-Production Infrastructure
# =============================================================================
# VPC and ECS cluster foundation for preview environments.
# Preview workloads run on Fargate with a single NAT gateway.
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
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project     = "yaffle"
      layer       = "core"
      tier        = "nonprod"
      environment = var.environment
      managed_by  = "yaffle"
    }
  }
}
