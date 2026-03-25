# =============================================================================
# GitHub Actions Deploy Role
# =============================================================================
# This role allows GitHub Actions to deploy the web app to S3.
# Scoped to only the buckets owned by this workspace.
#
# CloudFront invalidation is handled by a separate role in apps/infra/
# =============================================================================

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

module "shared" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

locals {
  github_oidc_provider_arn = module.shared.github_actions_oidc_provider_arn
}

# -----------------------------------------------------------------------------
# Deploy Role
# -----------------------------------------------------------------------------

resource "aws_iam_role" "deploy" {
  name        = "yaffle-deploy-web-${local.name_suffix}"
  description = "Role for GitHub Actions to deploy web app to S3"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = local.github_oidc_provider_arn
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
    Name = "yaffle-deploy-web-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# S3 Deploy Policy
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "deploy_s3" {
  name = "s3-deploy"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ListBucket"
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.primary.arn,
          aws_s3_bucket.replica.arn
        ]
      },
      {
        Sid    = "WriteObjects"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObject"
        ]
        Resource = [
          "${aws_s3_bucket.primary.arn}/*",
          "${aws_s3_bucket.replica.arn}/*"
        ]
      }
    ]
  })
}
