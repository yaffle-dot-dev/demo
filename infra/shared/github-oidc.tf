# =============================================================================
# GitHub Actions OIDC Provider
# =============================================================================
# This enables GitHub Actions to assume IAM roles using OIDC federation,
# eliminating the need for long-lived AWS credentials stored as secrets.
#
# Reference: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services
# =============================================================================

# The OIDC provider for GitHub Actions
# This is a singleton resource - only one per AWS account
resource "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # GitHub's OIDC thumbprint
  # This is the SHA-1 thumbprint of the intermediate CA certificate
  # See: https://github.blog/changelog/2023-06-27-github-actions-update-on-oidc-integration-with-aws/
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]

  tags = {
    Name      = "github-actions-oidc"
    ManagedBy = "terraform"
  }
}

# =============================================================================
# CI Role for Integration Tests
# =============================================================================
# This role is assumed by GitHub Actions to run integration tests.
# It has limited permissions: only what's needed for tests.
# =============================================================================

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "github_actions_ci" {
  name        = "yaffle-github-actions-ci"
  description = "Role for GitHub Actions CI to run integration tests"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github_actions.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # Allow from any branch/PR in the yaffle repo
            # Format: repo:{owner}/{repo}:ref:refs/heads/{branch}
            # or: repo:{owner}/{repo}:pull_request
            "token.actions.githubusercontent.com:sub" = [
              "repo:yaffle-dot-dev/yaffle:*",
              # Also allow from forks for PR builds (read-only)
              "repo:*/yaffle:pull_request"
            ]
          }
        }
      }
    ]
  })

  tags = {
    Name      = "yaffle-github-actions-ci"
    ManagedBy = "terraform"
  }
}

# Policy for S3 state bucket access (needed for TFC integration tests)
#
# TODO: Create a dedicated test state bucket (yaffle-state-ci-test) and restrict
# this policy to only that bucket. Currently the integration tests use a real
# state bucket which is not ideal.
#
# For now, we grant:
# - Read access to state buckets (for testing state download)
# - Write access ONLY to a ci-test prefix (for testing state upload)
#
# This is a temporary compromise. The integration tests need:
# 1. A dedicated test bucket created in nonprod
# 2. This policy updated to only access that bucket
# 3. The tests updated to use YAFFLE_STATE_BUCKET=yaffle-state-ci-test-...
resource "aws_iam_role_policy" "github_actions_ci_s3" {
  name = "s3-state-access"
  role = aws_iam_role.github_actions_ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ListStateBuckets"
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::yaffle-state-*"
        ]
      },
      {
        Sid    = "ReadStateObjects"
        Effect = "Allow"
        Action = [
          "s3:GetObject"
        ]
        Resource = [
          "arn:aws:s3:::yaffle-state-*/*"
        ]
      },
      {
        Sid    = "WriteTestStateOnly"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = [
          # Only allow writes to ci-test prefixed paths
          "arn:aws:s3:::yaffle-state-*/ci-test/*"
        ]
      }
    ]
  })
}

# =============================================================================
# ECR Push Policy
# =============================================================================
# Allows GitHub Actions to push container images to ECR.
# Used by CI to build and push control-plane and runner images.
# =============================================================================

resource "aws_iam_role_policy" "github_actions_ci_ecr" {
  name = "ecr-push"
  role = aws_iam_role.github_actions_ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ECRAuth"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = [
          "arn:aws:ecr:*:${data.aws_caller_identity.current.account_id}:repository/yaffle-*"
        ]
      }
    ]
  })
}
