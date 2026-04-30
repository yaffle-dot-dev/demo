locals {
  normalized_allowed_session_tag_keys  = sort(distinct(var.allowed_session_tag_keys))
  normalized_required_session_tag_keys = sort(distinct(var.required_session_tag_keys))
}

data "aws_iam_policy_document" "assume_role" {
  statement {
    sid    = "AllowYaffleAssumeRole"
    effect = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [var.yaffle_principal_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }

    dynamic "condition" {
      for_each = toset(local.normalized_required_session_tag_keys)

      content {
        test     = "Null"
        variable = "aws:RequestTag/${condition.value}"
        values   = ["false"]
      }
    }

    dynamic "condition" {
      for_each = var.required_session_tag_equals

      content {
        test     = "StringEquals"
        variable = "aws:RequestTag/${condition.key}"
        values   = [condition.value]
      }
    }

    dynamic "condition" {
      for_each = var.required_session_tag_not_equals

      content {
        test     = "StringNotEquals"
        variable = "aws:RequestTag/${condition.key}"
        values   = [condition.value]
      }
    }
  }

  dynamic "statement" {
    for_each = length(local.normalized_allowed_session_tag_keys) > 0 ? [local.normalized_allowed_session_tag_keys] : []

    content {
      sid     = "AllowYaffleTagSession"
      effect  = "Allow"
      actions = ["sts:TagSession"]

      principals {
        type        = "AWS"
        identifiers = [var.yaffle_principal_arn]
      }

      condition {
        test     = "ForAllValues:StringEquals"
        variable = "aws:TagKeys"
        values   = statement.value
      }

      dynamic "condition" {
        for_each = toset(local.normalized_required_session_tag_keys)

        content {
          test     = "Null"
          variable = "aws:RequestTag/${condition.value}"
          values   = ["false"]
        }
      }

      dynamic "condition" {
        for_each = var.required_session_tag_equals

        content {
          test     = "StringEquals"
          variable = "aws:RequestTag/${condition.key}"
          values   = [condition.value]
        }
      }

      dynamic "condition" {
        for_each = var.required_session_tag_not_equals

        content {
          test     = "StringNotEquals"
          variable = "aws:RequestTag/${condition.key}"
          values   = [condition.value]
        }
      }
    }
  }
}

resource "aws_iam_role" "yaffle_role" {
  name                 = var.role_name
  assume_role_policy   = data.aws_iam_policy_document.assume_role.json
  max_session_duration = 3600
  permissions_boundary = var.permissions_boundary_arn

  tags = merge(
    {
      project     = "yaffle"
      environment = var.environment
      managed_by  = "terraform"
    },
    var.tags,
  )
}

resource "aws_iam_role_policy_attachment" "managed" {
  count = length(var.managed_policy_arns)

  role       = aws_iam_role.yaffle_role.name
  policy_arn = var.managed_policy_arns[count.index]
}
