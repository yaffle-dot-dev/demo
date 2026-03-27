# =============================================================================
# Depot CI OIDC Provider
# =============================================================================
# This enables Depot CI to assume IAM roles using OIDC federation,
# eliminating the need for long-lived AWS credentials.
#
# Reference: https://depot.dev/docs/ci/oidc
# =============================================================================

resource "aws_iam_openid_connect_provider" "depot" {
  url = "https://identity.depot.dev"

  client_id_list = ["sts.amazonaws.com"]

  # AWS computes the thumbprint automatically for OIDC providers
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]

  tags = {
    Name      = "depot-oidc"
    ManagedBy = "terraform"
  }
}

# =============================================================================
# Depot CI Role
# =============================================================================
# This role is assumed by Depot CI runners via OIDC federation.
# It mirrors the permissions of the GitHub Actions CI role.
# =============================================================================

resource "aws_iam_role" "depot_ci" {
  name        = "yaffle-depot-ci"
  description = "Role for Depot CI to assume via OIDC federation"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.depot.arn
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
    Name      = "yaffle-depot-ci"
    ManagedBy = "terraform"
  }
}

# Policy for S3 state bucket access
resource "aws_iam_role_policy" "depot_ci_s3" {
  name = "s3-state-access"
  role = aws_iam_role.depot_ci.id

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
          "arn:aws:s3:::yaffle-state-*/ci-test/*"
        ]
      }
    ]
  })
}

# ECR push policy
resource "aws_iam_role_policy" "depot_ci_ecr" {
  name = "ecr-push"
  role = aws_iam_role.depot_ci.id

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

# Tailscale bootstrap policy
resource "aws_iam_role_policy" "depot_ci_tailscale" {
  name = "tailscale-bootstrap"
  role = aws_iam_role.depot_ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadTailscaleBootstrapSecret"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          aws_secretsmanager_secret.tailscale_github_actions_oauth.arn,
        ]
      },
    ]
  })
}

# Runtime secrets policy
resource "aws_iam_role_policy" "depot_ci_runtime_secrets" {
  name = "runtime-secrets"
  role = aws_iam_role.depot_ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadCloudflareAndWorkerSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/shared/cloudflare/*",
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/shared/github-actions/*",
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/*/provider-discovery-agent/*",
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/*/database-url*",
        ]
      },
      {
        Sid      = "ListSecretsForResolution"
        Effect   = "Allow"
        Action   = ["secretsmanager:ListSecrets"]
        Resource = "*"
      },
    ]
  })
}

# ECS deploy policy
resource "aws_iam_role_policy" "depot_ci_ecs_deploy" {
  name = "ecs-deploy"
  role = aws_iam_role.depot_ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ECSTaskDefinition"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
        ]
        Resource = "*"
      },
      {
        Sid    = "ECSServiceDeploy"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices",
        ]
        Resource = [
          "arn:aws:ecs:*:${data.aws_caller_identity.current.account_id}:service/yaffle-*/yaffle-*"
        ]
      },
      {
        Sid    = "PassRoleForTaskDef"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-cp-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-web-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-ecs-exec-*",
        ]
      },
    ]
  })
}
