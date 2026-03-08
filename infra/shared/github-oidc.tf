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
    Name        = "github-actions-oidc"
    Environment = var.environment
    ManagedBy   = "terraform"
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
  name        = "yaffle-github-actions-ci-${local.name_suffix}"
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
    Name        = "yaffle-github-actions-ci"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Policy for S3 state bucket access (needed for TFC integration tests)
resource "aws_iam_role_policy" "github_actions_ci_s3" {
  name = "s3-state-access"
  role = aws_iam_role.github_actions_ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "StateBucketAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.state.arn,
          "${aws_s3_bucket.state.arn}/*"
        ]
      }
    ]
  })
}

# Policy to allow reading Terraform state (for outputs-action)
# This uses the same state bucket but limits to reading only
resource "aws_iam_role_policy" "github_actions_ci_tfstate_read" {
  name = "tfstate-read"
  role = aws_iam_role.github_actions_ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadTerraformState"
        Effect = "Allow"
        Action = [
          "s3:GetObject"
        ]
        Resource = [
          "${aws_s3_bucket.state.arn}/env:*/yaffle/*"
        ]
      }
    ]
  })
}
