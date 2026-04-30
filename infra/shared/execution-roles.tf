locals {
  self_hosted_protected_record_names = [
    var.domain,
    "www.${var.domain}",
    "api.${var.domain}",
    "internal.${var.domain}",
    "cp.internal.${var.domain}",
  ]

  self_hosted_protected_secret_arns = [
    "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/main/*",
    "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:yaffle/shared/*",
    "arn:aws:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/yaffle/main/*",
    "arn:aws:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/yaffle/shared/*",
    "arn:aws:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/yaffle/ci/main/*",
  ]

  self_hosted_protected_state_bucket_arns = [
    "arn:aws:s3:::yaffle-state-main-*",
    "arn:aws:s3:::yaffle-state-main-*/*",
  ]

  self_hosted_protected_main_bucket_arns = [
    "arn:aws:s3:::yaffle-*-main-*",
    "arn:aws:s3:::yaffle-*-main-*/*",
  ]

  self_hosted_non_main_read_actions = [
    "acm:Describe*",
    "acm:Get*",
    "acm:List*",
    "application-autoscaling:Describe*",
    "cloudfront:Get*",
    "cloudfront:List*",
    "cloudwatch:Describe*",
    "cloudwatch:Get*",
    "cloudwatch:List*",
    "ec2:Describe*",
    "ecr:BatchGet*",
    "ecr:Describe*",
    "ecr:Get*",
    "ecr:List*",
    "ecs:Describe*",
    "ecs:List*",
    "elasticloadbalancing:Describe*",
    "iam:Get*",
    "iam:List*",
    "iam:Simulate*",
    "kms:Describe*",
    "kms:Get*",
    "kms:List*",
    "lambda:Get*",
    "lambda:List*",
    "logs:Describe*",
    "logs:FilterLogEvents",
    "logs:Get*",
    "logs:List*",
    "logs:StartQuery",
    "logs:StopQuery",
    "rds:Describe*",
    "rds:List*",
    "route53:Get*",
    "route53:List*",
    "route53:TestDNSAnswer",
    "s3:Get*",
    "s3:List*",
    "secretsmanager:Describe*",
    "secretsmanager:GetResourcePolicy",
    "secretsmanager:List*",
    "servicediscovery:DiscoverInstances",
    "servicediscovery:Get*",
    "servicediscovery:List*",
    "sns:Get*",
    "sns:List*",
    "sqs:Get*",
    "sqs:List*",
    "ssm:Describe*",
    "ssm:GetResourcePolicies",
    "ssm:List*",
    "sts:GetCallerIdentity",
    "tag:Get*",
    "wafv2:Get*",
    "wafv2:List*",
  ]

  self_hosted_non_main_s3_write_actions = [
    "s3:Abort*",
    "s3:CreateBucket",
    "s3:Delete*",
    "s3:ObjectOwnerOverrideToBucketOwner",
    "s3:Put*",
    "s3:Replicate*",
    "s3:RestoreObject",
    "s3:Update*",
  ]

  self_hosted_non_main_create_or_tag_actions = [
    "acm:RequestCertificate",
    "application-autoscaling:Put*",
    "application-autoscaling:RegisterScalableTarget",
    "cloudfront:Create*",
    "cloudfront:TagResource",
    "cloudfront:UntagResource",
    "cloudwatch:Put*",
    "ec2:Create*",
    "ec2:RunInstances",
    "ec2:CreateTags",
    "ecr:Create*",
    "ecr:Put*",
    "ecr:TagResource",
    "ecr:UntagResource",
    "ecs:Create*",
    "ecs:Register*",
    "ecs:TagResource",
    "ecs:UntagResource",
    "elasticloadbalancing:AddTags",
    "elasticloadbalancing:Create*",
    "iam:Create*",
    "iam:Put*",
    "iam:Tag*",
    "iam:Untag*",
    "kms:Create*",
    "kms:TagResource",
    "kms:UntagResource",
    "lambda:Create*",
    "lambda:TagResource",
    "lambda:UntagResource",
    "logs:Create*",
    "logs:Put*",
    "logs:Tag*",
    "logs:Untag*",
    "rds:AddTagsToResource",
    "rds:Create*",
    "rds:RemoveTagsFromResource",
    "route53:ChangeTagsForResource",
    "route53:Create*",
    "s3:CreateBucket",
    "s3:PutBucket*",
    "s3:PutObject*",
    "s3:PutStorageLensConfigurationTagging",
    "s3:PutStorageLensGroup",
    "secretsmanager:Create*",
    "secretsmanager:Put*",
    "secretsmanager:TagResource",
    "secretsmanager:UntagResource",
    "servicediscovery:Create*",
    "servicediscovery:TagResource",
    "servicediscovery:UntagResource",
    "sns:Create*",
    "sns:Set*",
    "sns:TagResource",
    "sns:UntagResource",
    "sqs:CreateQueue",
    "sqs:SetQueueAttributes",
    "sqs:TagQueue",
    "sqs:UntagQueue",
    "ssm:AddTagsToResource",
    "ssm:PutParameter",
    "ssm:RemoveTagsFromResource",
    "wafv2:Create*",
    "wafv2:Put*",
    "wafv2:TagResource",
    "wafv2:UntagResource",
  ]
}

data "aws_iam_policy_document" "self_hosted_non_main_write_scope_guardrails" {
  statement {
    sid         = "DenyNonReadActionsOutsideEnvironment"
    effect      = "Deny"
    not_actions = local.self_hosted_non_main_read_actions
    resources   = ["*"]

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "aws:ResourceTag/environment"
      values   = ["&{aws:PrincipalTag/environment}"]
    }
  }
}

data "aws_iam_policy_document" "self_hosted_non_main_create_scope_guardrails" {
  statement {
    sid       = "DenyCreatesOutsideEnvironment"
    effect    = "Deny"
    actions   = local.self_hosted_non_main_create_or_tag_actions
    resources = ["*"]

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "aws:RequestTag/environment"
      values   = ["&{aws:PrincipalTag/environment}"]
    }
  }

  statement {
    sid       = "DenyCreatesSharedResources"
    effect    = "Deny"
    actions   = local.self_hosted_non_main_create_or_tag_actions
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "aws:RequestTag/yaffle:resource-class"
      values   = ["shared*"]
    }
  }
}

data "aws_iam_policy_document" "self_hosted_non_main_sensitive_guardrails" {
  statement {
    sid       = "DenyWritesToMainBuckets"
    effect    = "Deny"
    actions   = local.self_hosted_non_main_s3_write_actions
    resources = local.self_hosted_protected_main_bucket_arns
  }

  statement {
    sid    = "DenySensitiveStateReads"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
    ]
    resources = local.self_hosted_protected_state_bucket_arns
  }

  statement {
    sid    = "DenySharedSecretReads"
    effect = "Deny"
    actions = [
      "secretsmanager:GetSecretValue",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = local.self_hosted_protected_secret_arns
  }

  statement {
    sid    = "DenyMutatingProtectedDnsRecords"
    effect = "Deny"
    actions = [
      "route53:ChangeResourceRecordSets",
    ]
    resources = ["*"]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = local.self_hosted_protected_record_names
    }
  }
}

resource "aws_iam_policy" "self_hosted_non_main_write_scope_guardrails" {
  name        = "${var.self_hosted_non_main_permissions_boundary_name}-write-scope"
  description = "Write-scope guardrails for non-main Yaffle execution roles"
  policy      = data.aws_iam_policy_document.self_hosted_non_main_write_scope_guardrails.json

  tags = {
    Name                    = "${var.self_hosted_non_main_permissions_boundary_name}-write-scope"
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}

resource "aws_iam_policy" "self_hosted_non_main_create_scope_guardrails" {
  name        = "${var.self_hosted_non_main_permissions_boundary_name}-create-scope"
  description = "Create-scope guardrails for non-main Yaffle execution roles"
  policy      = data.aws_iam_policy_document.self_hosted_non_main_create_scope_guardrails.json

  tags = {
    Name                    = "${var.self_hosted_non_main_permissions_boundary_name}-create-scope"
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}

resource "aws_iam_policy" "self_hosted_non_main_sensitive_guardrails" {
  name        = "${var.self_hosted_non_main_permissions_boundary_name}-sensitive"
  description = "Sensitive-resource guardrails for non-main Yaffle execution roles"
  policy      = data.aws_iam_policy_document.self_hosted_non_main_sensitive_guardrails.json

  tags = {
    Name                    = "${var.self_hosted_non_main_permissions_boundary_name}-sensitive"
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}

module "self_hosted_main_execution_role" {
  source = "../../infra_modules/public/bootstrap-yaffle/aws"

  yaffle_principal_arn      = var.self_hosted_org_broker_role_arn
  external_id               = var.self_hosted_main_external_id
  role_name                 = var.self_hosted_main_execution_role_name
  environment               = "main"
  managed_policy_arns       = var.self_hosted_main_managed_policy_arns
  allowed_session_tag_keys  = ["environment"]
  required_session_tag_keys = ["environment"]
  required_session_tag_equals = {
    environment = "main"
  }

  tags = {
    Name                    = var.self_hosted_main_execution_role_name
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}

module "self_hosted_non_main_execution_role" {
  source = "../../infra_modules/public/bootstrap-yaffle/aws"

  yaffle_principal_arn = var.self_hosted_org_broker_role_arn
  external_id          = var.self_hosted_non_main_external_id
  role_name            = var.self_hosted_non_main_execution_role_name
  environment          = "non-main"
  managed_policy_arns = concat(
    var.self_hosted_non_main_managed_policy_arns,
    [
      aws_iam_policy.self_hosted_non_main_write_scope_guardrails.arn,
      aws_iam_policy.self_hosted_non_main_create_scope_guardrails.arn,
      aws_iam_policy.self_hosted_non_main_sensitive_guardrails.arn,
    ],
  )
  allowed_session_tag_keys  = ["environment"]
  required_session_tag_keys = ["environment"]
  required_session_tag_not_equals = {
    environment = "main"
  }

  tags = {
    Name                    = var.self_hosted_non_main_execution_role_name
    "yaffle:resource-class" = local.shared_resource_classes.ci_identity
  }
}
