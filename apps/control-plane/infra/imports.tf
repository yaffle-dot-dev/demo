# =============================================================================
# Import blocks for bootstrapped resources
# =============================================================================
# The state bucket was bootstrapped via modules/bootstrap/ and imported
# into the production workspace. These import blocks have been removed
# after successful import.
#
# If you need to re-import (e.g., after state loss), temporarily add:
#
#   import {
#     to = aws_s3_bucket.state
#     id = "yaffle-state-main-use1"
#   }
#
# Then run `terraform apply` and remove the import block.
#
# WARNING: Import blocks apply to ALL environments including previews.
# Never commit import blocks that reference production resources.
# =============================================================================
