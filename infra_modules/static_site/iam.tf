# =============================================================================
# GitHub Actions Deploy Role
# =============================================================================
# This role allows GitHub Actions to deploy the ${var.site_name} site to S3.
# Scoped to only the buckets owned by this workspace.
#
# CloudFront invalidation is handled by a separate role in apps/infra/
# =============================================================================

# -----------------------------------------------------------------------------
# Deploy Role
# -----------------------------------------------------------------------------

locals {
  deploy_assume_role_statements = concat(
    [
      {
        Effect = "Allow"
        Principal = {
          Federated = var.github_oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = [
              "repo:yaffle-dot-dev/yaffle:ref:refs/heads/main",
              "repo:yaffle-dot-dev/yaffle:pull_request",
            ]
          }
        }
      },
      {
        Effect = "Allow"
        Principal = {
          Federated = var.depot_oidc_provider_arn
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
      },
    ],
    length(var.deployer_role_arns) > 0 ? [
      {
        Effect = "Allow"
        Principal = {
          AWS = var.deployer_role_arns
        }
        Action = "sts:AssumeRole"
      },
    ] : [],
  )
}

resource "aws_iam_role" "deploy" {
  name        = "yaffle-deploy-${var.site_name}-${local.name_suffix}"
  description = "Role for GitHub Actions to deploy ${var.site_name} site to S3"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.deploy_assume_role_statements
  })

  tags = {
    Name = "yaffle-deploy-${var.site_name}-${local.name_suffix}"
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
