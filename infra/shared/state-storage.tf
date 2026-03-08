# =============================================================================
# Terraform State Storage
# =============================================================================
# Shared S3 bucket and DynamoDB table for all Terraform state.
# Primary bucket replicates to a secondary region for disaster recovery.
#
# State key structure:
#   shared/terraform.tfstate           - This module
#   production/terraform.tfstate       - Production core infra
#   nonprod/terraform.tfstate          - Non-production core infra
#   apps/control-plane/production/*    - Control plane prod
#   apps/control-plane/preview-pr-*/*  - Control plane previews
# =============================================================================

# -----------------------------------------------------------------------------
# Primary State Bucket
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = "yaffle-state-${local.name_suffix}"

  # Never allow destruction of state bucket
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

    filter {} # Apply to all objects

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # Aggressively clean up preview state (after PR is closed/merged)
  rule {
    id     = "cleanup-preview-state"
    status = "Enabled"

    filter {
      prefix = "apps/control-plane/preview-"
    }

    expiration {
      days = 30 # Previews should be destroyed, but cleanup stragglers
    }
  }
}

# -----------------------------------------------------------------------------
# Replica State Bucket (Cross-Region)
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "state_replica" {
  provider = aws.replica
  bucket   = "yaffle-state-${var.environment}-${local.replica_region_short}"

  force_destroy = false

  tags = {
    Name = "yaffle-state-${var.environment}-${local.replica_region_short}"
  }
}

resource "aws_s3_bucket_versioning" "state_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.state_replica.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.state_replica.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.state_replica.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# -----------------------------------------------------------------------------
# Replication Configuration
# -----------------------------------------------------------------------------

resource "aws_iam_role" "replication" {
  name = "yaffle-state-replication-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "s3.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "yaffle-state-replication-${local.name_suffix}"
  }
}

resource "aws_iam_role_policy" "replication" {
  name = "replication-policy"
  role = aws_iam_role.replication.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetReplicationConfiguration",
          "s3:ListBucket"
        ]
        Resource = aws_s3_bucket.state.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging"
        ]
        Resource = "${aws_s3_bucket.state.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags"
        ]
        Resource = "${aws_s3_bucket.state_replica.arn}/*"
      }
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  role   = aws_iam_role.replication.arn

  rule {
    id     = "replicate-all"
    status = "Enabled"

    destination {
      bucket        = aws_s3_bucket.state_replica.arn
      storage_class = "STANDARD"
    }
  }

  depends_on = [
    aws_s3_bucket_versioning.state,
    aws_s3_bucket_versioning.state_replica
  ]
}
