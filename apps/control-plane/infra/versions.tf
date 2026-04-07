# =============================================================================
# Control Plane Application Infrastructure
# =============================================================================
# This is the complete infrastructure for a Yaffle environment, including:
# - State storage (S3 bucket + replication)
# - ECS service, ALB, IAM roles
# - References to shared infra (Route53, OIDC) and core infra (VPC, ECS cluster)
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
    planetscale = {
      source  = "planetscale/planetscale"
      version = "~> 1.0"
    }
  }

  # Backend is injected by Yaffle via backend_override.tf
  # Do not add a backend block here - Yaffle manages state storage
}

locals {
  control_plane_resource_classes = {
    default         = "control-plane"
    compute         = "control-plane-compute"
    load_balancer   = "control-plane-alb"
    logs            = "control-plane-logs"
    dns             = "control-plane-dns"
    network         = "control-plane-network"
    secrets         = "control-plane-secrets"
    state_storage   = "control-plane-state-storage"
    workspace_cache = "control-plane-workspace-cache"
    iam             = "control-plane-iam"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project                 = "yaffle"
      layer                   = "app"
      app                     = "control-plane"
      environment             = var.environment
      managed_by              = "yaffle"
      "yaffle:resource-class" = local.control_plane_resource_classes.default
    }
  }
}

# Cloudflare provider for dual DNS (api.yaffle.dev record)
provider "cloudflare" {}

provider "planetscale" {}

# Replica provider for cross-region state bucket replication
provider "aws" {
  alias  = "replica"
  region = var.replica_region

  default_tags {
    tags = {
      project                 = "yaffle"
      layer                   = "app"
      app                     = "control-plane"
      environment             = var.environment
      managed_by              = "yaffle"
      "yaffle:resource-class" = local.control_plane_resource_classes.default
    }
  }
}
