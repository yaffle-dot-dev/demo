# =============================================================================
# Micro Site Module
# =============================================================================
# Generates CloudFront configuration for a static micro-site:
# - Origin Access Control
# - Primary and replica origins
# - Origin group for failover
#
# This module outputs configuration objects that are consumed by the main
# CloudFront distribution in apps/infra/cloudfront.tf.
# =============================================================================

# -----------------------------------------------------------------------------
# Origin Access Control
# -----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "this" {
  name                              = "yaffle-${var.site_name}-${var.name_suffix}"
  description                       = "OAC for yaffle ${var.site_name} S3 buckets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
