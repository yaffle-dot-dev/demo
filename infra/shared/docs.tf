# =============================================================================
# Public Documentation Site - S3 Static Hosting
# =============================================================================
# S3 bucket for hosting the public documentation site (Astro Starlight).
# Served at yaffle.dev/docs/ - integration with main CloudFront distribution
# will be configured separately.
# =============================================================================

resource "aws_s3_bucket" "docs" {
  bucket = "yaffle-docs-${var.aws_region}"

  tags = {
    Name                    = "yaffle-docs"
    "yaffle:resource-class" = local.shared_resource_classes.docs
  }
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket = aws_s3_bucket.docs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "docs" {
  bucket = aws_s3_bucket.docs.id

  versioning_configuration {
    status = "Enabled"
  }
}

# -----------------------------------------------------------------------------
# Origin Access Control
# -----------------------------------------------------------------------------
# OAC for CloudFront to access the private S3 bucket.
# The main site's CloudFront distribution will use this as an origin.
# -----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "docs" {
  name                              = "yaffle-docs-oac"
  description                       = "OAC for Yaffle docs S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
