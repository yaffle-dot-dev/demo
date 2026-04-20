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
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.21"
    }
    stripe = {
      source  = "lukasaron/stripe"
      version = "~> 2.0"
    }
    hookdeck = {
      source  = "hookdeck/hookdeck"
      version = "~> 2.0"
    }
  }

  # Backend is injected by Yaffle via backend_override.tf
  # Do not add a backend block here - Yaffle manages state storage
}

locals {
  shared_resource_classes = {
    default     = "shared"
    dns         = "shared-dns"
    certificate = "shared-certificate"
    ci_identity = "shared-ci-identity"
    secrets     = "shared-secrets"
    docs        = "shared-docs"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project                 = "yaffle"
      layer                   = "shared"
      "yaffle:resource-class" = local.shared_resource_classes.default
    }
  }
}

# Cloudflare provider for dual DNS setup
# Authenticates via CLOUDFLARE_API_TOKEN env var
provider "cloudflare" {}

# Tailscale provider for shared singleton credentials.
# Auth via TAILSCALE_API_KEY or provider-supported OAuth env vars such as
# TAILSCALE_OAUTH_CLIENT_ID / TAILSCALE_OAUTH_CLIENT_SECRET.
provider "tailscale" {}

# Stripe provider for billing product catalog.
# Authenticates via STRIPE_API_KEY env var (set by connection, not in state).
provider "stripe" {}

# Hookdeck provider for GitHub webhook ingress and routing.
# Authenticates via HOOKDECK_API_KEY env var (set by connection, not in state).
provider "hookdeck" {}
