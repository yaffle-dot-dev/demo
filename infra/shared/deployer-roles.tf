locals {
  deployer_principal_arns = distinct(var.deployer_principal_arns)
  app_deployer_role_arn   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-app-deployer"
  app_deployer_assume_role_statements = [
    {
      Effect = "Allow"
      Principal = {
        AWS = concat(local.deployer_principal_arns, [local.app_deployer_role_arn])
      }
      Action = "sts:AssumeRole"
    },
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
          "token.actions.githubusercontent.com:sub" = [
            "repo:yaffle-dot-dev/yaffle:ref:refs/heads/main",
            "repo:yaffle-dot-dev/yaffle:pull_request",
          ]
        }
      }
    },
  ]
}

resource "aws_iam_role" "site_deployer" {
  name        = "yaffle-site-deployer"
  description = "Human deployer role for the marketing site"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = local.deployer_principal_arns
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name                    = "yaffle-site-deployer"
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}

resource "aws_iam_role_policy" "site_deployer" {
  name = "assume-site-deploy-roles"
  role = aws_iam_role.site_deployer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-deploy-marketing-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-deploy-invalidation-*",
        ]
      },
    ]
  })
}

resource "aws_iam_role" "docs_deployer" {
  name        = "yaffle-docs-deployer"
  description = "Human deployer role for docs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = local.deployer_principal_arns
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name                    = "yaffle-docs-deployer"
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}

resource "aws_iam_role_policy" "docs_deployer" {
  name = "assume-docs-deploy-roles"
  role = aws_iam_role.docs_deployer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-deploy-docs-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-deploy-invalidation-*",
        ]
      },
    ]
  })
}

resource "aws_iam_role" "app_deployer" {
  name        = "yaffle-app-deployer"
  description = "Human deployer role for the app stack"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.app_deployer_assume_role_statements
  })

  tags = {
    Name                    = "yaffle-app-deployer"
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}

resource "aws_iam_role_policy" "app_deployer" {
  name = "app-deploy"
  role = aws_iam_role.app_deployer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AssumeWebDeployRole"
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Resource = [
          local.app_deployer_role_arn,
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-deploy-web-*",
        ]
      },
      {
        Sid    = "ECRAuth"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
        ]
        Resource = "*"
      },
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:DescribeImages",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
        ]
        Resource = [
          "arn:aws:ecr:*:${data.aws_caller_identity.current.account_id}:repository/yaffle-*",
        ]
      },
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
          "arn:aws:ecs:*:${data.aws_caller_identity.current.account_id}:service/yaffle-*/yaffle-*",
        ]
      },
      {
        Sid    = "PassRoleForTaskDef"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-cp-task-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-ecs-exec-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-web-task-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-web-ecs-exec-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-runner-task-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yaffle-runner-exec-*",
        ]
      },
      {
        Sid    = "ReadRuntimeSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/shared/cloudflare/*",
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/shared/github-actions/*",
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/*/provider-discovery-agent/*",
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/*/database-url*",
          "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/*/database-migration-url*",
        ]
      },
      {
        Sid    = "UpdateScanner"
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionCode",
          "lambda:InvokeFunction",
        ]
        Resource = [
          "arn:aws:lambda:*:${data.aws_caller_identity.current.account_id}:function:yaffle-scanner-*",
          "arn:aws:lambda:*:${data.aws_caller_identity.current.account_id}:function:yaffle-traffic-controller-api-*",
          "arn:aws:lambda:*:${data.aws_caller_identity.current.account_id}:function:yaffle-traffic-controller-reconcile-*",
        ]
      },
    ]
  })
}
