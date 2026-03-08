# =============================================================================
# Provider Configuration (for standalone use)
# =============================================================================
# When run as a standalone root module, this configures the AWS provider.
# When consumed as a child module, the parent provides the AWS provider.
# =============================================================================

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project    = "yaffle"
      managed_by = "bootstrap"
    }
  }
}
