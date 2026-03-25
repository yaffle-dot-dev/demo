# =============================================================================
# GitHub Actions CloudFront Invalidation Role
# =============================================================================
# This role allows GitHub Actions to invalidate the CloudFront cache.
# Used by marketing and web deployments after S3 sync.
#
# S3 deploy permissions are in each app's own infra (apps/marketing/infra, etc.)
# =============================================================================

# -----------------------------------------------------------------------------
# Deploy Invalidation Role
# -----------------------------------------------------------------------------

resource "aws_iam_role" "invalidation" {
  name        = "yaffle-deploy-invalidation-${local.name_suffix}"
  description = "Role for GitHub Actions to invalidate CloudFront cache"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = module.shared.github_actions_oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # Allow from main branch and PRs in the yaffle repo
            "token.actions.githubusercontent.com:sub" = [
              "repo:yaffle-dot-dev/yaffle:ref:refs/heads/main",
              "repo:yaffle-dot-dev/yaffle:pull_request"
            ]
          }
        }
      },
      {
        Effect = "Allow"
        Principal = {
          Federated = module.shared.depot_oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "identity.depot.dev:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "identity.depot.dev:sub" = "spiffe://identity.depot.dev/org/rtlw6kg4g8/ci/github/yaffle-dot-dev/yaffle/*"
          }
        }
      }
    ]
  })

  tags = {
    Name = "yaffle-deploy-invalidation-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# CloudFront Invalidation Policy
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "invalidation_cloudfront" {
  name = "cloudfront-invalidation"
  role = aws_iam_role.invalidation.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CreateInvalidation"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation",
          "cloudfront:ListInvalidations"
        ]
        Resource = aws_cloudfront_distribution.main.arn
      }
    ]
  })
}
