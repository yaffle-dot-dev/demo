# =============================================================================
# Import blocks for bootstrapped resources
# =============================================================================
# These resources were created manually or by previous terraform runs.
# Import blocks bring them under terraform management.
# After successful import, these blocks can be removed.

# -----------------------------------------------------------------------------
# State Storage
# -----------------------------------------------------------------------------

import {
  to = aws_s3_bucket.state
  id = "yaffle-state-production-use1"
}

import {
  to = aws_s3_bucket_versioning.state
  id = "yaffle-state-production-use1"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.state
  id = "yaffle-state-production-use1"
}

import {
  to = aws_s3_bucket_public_access_block.state
  id = "yaffle-state-production-use1"
}

import {
  to = aws_s3_bucket_lifecycle_configuration.state
  id = "yaffle-state-production-use1"
}

import {
  to = aws_s3_bucket.state_replica
  id = "yaffle-state-production-usw2"
}

import {
  to = aws_s3_bucket_versioning.state_replica
  id = "yaffle-state-production-usw2"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.state_replica
  id = "yaffle-state-production-usw2"
}

import {
  to = aws_s3_bucket_public_access_block.state_replica
  id = "yaffle-state-production-usw2"
}

# -----------------------------------------------------------------------------
# Replication
# -----------------------------------------------------------------------------

import {
  to = aws_iam_role.replication
  id = "yaffle-state-replication-production-use1"
}

import {
  to = aws_iam_role_policy.replication
  id = "yaffle-state-replication-production-use1:replication-policy"
}

import {
  to = aws_s3_bucket_replication_configuration.state
  id = "yaffle-state-production-use1"
}

# -----------------------------------------------------------------------------
# DNS
# -----------------------------------------------------------------------------

import {
  to = aws_route53_zone.main
  id = "Z06030571FDH4SIGAU656"
}

import {
  to = aws_route53_record.apex
  id = "Z06030571FDH4SIGAU656_yaffle.dev_A"
}

import {
  to = aws_route53_record.www
  id = "Z06030571FDH4SIGAU656_www.yaffle.dev_CNAME"
}
