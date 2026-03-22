# =============================================================================
# Workspace Cache
# =============================================================================
# S3 bucket for caching workspace tarballs.
#
# Workspaces are cloned once per SHA during webhook processing and uploaded
# to S3. All jobs for that SHA (across multiple workspaces, multiple PRs)
# share the same cached workspace.
#
# Key structure: {org}/{repo}/{sha}/workspace.tar.gz
#
# Lifecycle: 7 days - workspaces are ephemeral and cheap to regenerate.
# =============================================================================

# -----------------------------------------------------------------------------
# S3 Bucket
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "workspace_cache" {
  bucket        = "yaffle-workspace-cache-${local.name_suffix}"
  force_destroy = local.is_preview

  tags = {
    Name = "yaffle-workspace-cache-${local.name_suffix}"
  }
}

resource "aws_s3_bucket_public_access_block" "workspace_cache" {
  bucket = aws_s3_bucket.workspace_cache.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "workspace_cache" {
  bucket = aws_s3_bucket.workspace_cache.id

  versioning_configuration {
    # No versioning needed - workspaces are immutable (keyed by SHA)
    status = "Disabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspace_cache" {
  bucket = aws_s3_bucket.workspace_cache.id

  rule {
    apply_server_side_encryption_by_default {
      # Use AWS-managed KMS key - no need for per-org isolation
      # Workspaces contain code that's already in GitHub (no secrets)
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "workspace_cache" {
  bucket = aws_s3_bucket.workspace_cache.id

  rule {
    id     = "expire-old-workspaces"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# -----------------------------------------------------------------------------
# IAM Policies
# -----------------------------------------------------------------------------

# Control plane: read/write access to upload workspaces and generate presigned URLs
resource "aws_iam_role_policy" "control_plane_workspace_cache" {
  name = "workspace-cache-access"
  role = aws_iam_role.control_plane_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WorkspaceCacheReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:PutObjectTagging",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.workspace_cache.arn,
          "${aws_s3_bucket.workspace_cache.arn}/*"
        ]
      }
    ]
  })
}

# Runner: uses presigned URLs to download workspaces
# No IAM policy needed - presigned URLs carry their own authorization.
# This is intentional: the runner is sandboxed and should not have direct
# S3 access beyond what the control plane grants via presigned URLs.

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "workspace_cache_bucket_name" {
  value       = aws_s3_bucket.workspace_cache.id
  description = "Workspace cache bucket name"
}

output "workspace_cache_bucket_arn" {
  value       = aws_s3_bucket.workspace_cache.arn
  description = "Workspace cache bucket ARN"
}
