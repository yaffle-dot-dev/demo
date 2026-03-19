# =============================================================================
# State Storage
# =============================================================================
# S3 bucket for this Yaffle environment's terraform state.
# Bootstrapped via modules/bootstrap/, then imported here.
# =============================================================================

# Import the bootstrapped state bucket (main environment only)
# The bootstrap module creates the bucket with local state, then we import it
# here to manage versioning, encryption, and lifecycle rules.
# Preview environments create their buckets fresh (no import needed).
import {
  for_each = var.environment == "main" ? { state = "yaffle-state-${local.name_suffix}" } : {}
  to       = module.bootstrap.aws_s3_bucket.state
  id       = each.value
}

import {
  for_each = var.environment == "main" ? { state = "yaffle-state-${local.name_suffix}" } : {}
  to       = module.bootstrap.aws_s3_bucket_public_access_block.state
  id       = each.value
}

module "bootstrap" {
  source = "./modules/bootstrap"

  environment      = var.environment
  environment_kind = var.environment_kind
  aws_region       = var.aws_region
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = module.bootstrap.bucket_name

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = module.bootstrap.bucket_name

  rule {
    apply_server_side_encryption_by_default {
      # Use AWS-managed KMS key by default
      # Per-org uploads override with their own CMK for isolation
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = module.bootstrap.bucket_name

  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30  # 30 days balances recovery needs vs secret exposure window
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "cleanup-preview-state"
    status = "Enabled"

    filter {
      prefix = "preview-pr-"
    }

    expiration {
      days = 30
    }
  }
}
