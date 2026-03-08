# =============================================================================
# Import blocks for bootstrapped resources
# =============================================================================
# The state bucket is bootstrapped via modules/bootstrap/.
# These import blocks bring it under management by this workspace.
# After successful import, these blocks can be removed.

# -----------------------------------------------------------------------------
# State Storage (bootstrapped for main environment)
# -----------------------------------------------------------------------------

import {
  to = aws_s3_bucket.state
  id = "yaffle-state-main-use1"
}

import {
  to = aws_s3_bucket_versioning.state
  id = "yaffle-state-main-use1"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.state
  id = "yaffle-state-main-use1"
}

import {
  to = aws_s3_bucket_public_access_block.state
  id = "yaffle-state-main-use1"
}

import {
  to = aws_s3_bucket_lifecycle_configuration.state
  id = "yaffle-state-main-use1"
}
