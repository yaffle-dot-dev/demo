# =============================================================================
# Shared Infrastructure
# =============================================================================
# Resources shared across all environments:
# - S3 bucket for Terraform state
# - DynamoDB table for state locking
# - Route53 hosted zone
#
# This must be deployed first, before production or nonprod.
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
      project = "yaffle"
      layer   = "shared"
    }
  }
}

# Replica region provider for cross-region replication
provider "aws" {
  alias  = "replica"
  region = var.replica_region

  default_tags {
    tags = {
      project = "yaffle"
      layer   = "shared"
    }
  }
}
