# =============================================================================
# State Storage
# =============================================================================
# S3 bucket for this Yaffle environment's terraform state.
# Bootstrapped via modules/bootstrap/, then imported here.
# =============================================================================

resource "aws_s3_bucket" "state" {
  bucket        = "yaffle-state-${local.name_suffix}"
  force_destroy = false

  tags = {
    Name = "yaffle-state-${local.name_suffix}"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
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
