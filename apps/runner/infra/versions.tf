# =============================================================================
# Terraform Configuration
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  cloud {
    hostname     = "yaffle.local:6969"
    organization = "yaffle-dot-dev"

    workspaces {
      name = "main-main-apps-runner-infra"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "yaffle"
      Environment = var.environment
      ManagedBy   = "tofu"
      Workspace   = "apps/runner/infra"
    }
  }
}
