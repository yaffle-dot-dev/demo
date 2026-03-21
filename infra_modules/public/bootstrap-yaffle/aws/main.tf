data "aws_iam_policy_document" "assume_role" {
  statement {
    sid     = "AllowYaffleAssumeRole"
    effect  = "Allow"
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
  }
}

resource "aws_iam_role" "yaffle_role" {
  name                 = var.role_name
  assume_role_policy   = data.aws_iam_policy_document.assume_role.json
  max_session_duration = 3600

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
  for_each = toset(var.managed_policy_arns)

  role       = aws_iam_role.yaffle_role.name
  policy_arn = each.value
}
