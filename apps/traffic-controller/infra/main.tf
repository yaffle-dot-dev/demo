module "shared" {
  source = "${var.module_registry_host}/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

locals {
  api_lambda_name       = "yaffle-traffic-controller-api-${local.name_suffix}"
  reconcile_lambda_name = "yaffle-traffic-controller-reconcile-${local.name_suffix}"
  reconcile_queue_name  = "yaffle-traffic-controller-reconcile-${local.name_suffix}"
  dlq_name              = "yaffle-traffic-controller-reconcile-dlq-${local.name_suffix}"

  github_app_id_secret_name          = "yaffle/${var.environment}/github-app-id"
  github_app_private_key_secret_name = "yaffle/${var.environment}/github-app-private-key"

  # Hookdeck runtime routing is controlled only from this service.
  hookdeck_github_source_id            = module.shared.hookdeck_github_source_id
  hookdeck_github_source_name          = module.shared.hookdeck_github_source_name
  hookdeck_production_destination_id   = module.shared.hookdeck_production_destination_id
  hookdeck_production_destination_name = module.shared.hookdeck_production_destination_name
  hookdeck_production_connection_name  = module.shared.hookdeck_production_connection_name
}

data "aws_secretsmanager_secret" "github_app_id" {
  name = local.github_app_id_secret_name
}

data "aws_secretsmanager_secret" "github_app_private_key" {
  name = local.github_app_private_key_secret_name
}

resource "aws_secretsmanager_secret" "database_url" {
  name        = "yaffle/${var.environment}/traffic-controller/database-url"
  description = "Traffic-controller database URL for ${var.environment}"

  tags = {
    Name                    = "yaffle-traffic-controller-database-url-${local.name_suffix}"
    "yaffle:resource-class" = local.traffic_controller_resource_classes.secrets
  }
}

resource "aws_sqs_queue" "reconcile_dlq" {
  name = local.dlq_name

  tags = {
    Name                    = local.dlq_name
    "yaffle:resource-class" = local.traffic_controller_resource_classes.queue
  }
}

resource "aws_sqs_queue" "reconcile" {
  name                       = local.reconcile_queue_name
  visibility_timeout_seconds = var.reconcile_lambda_timeout_seconds * 2
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.reconcile_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    Name                    = local.reconcile_queue_name
    "yaffle:resource-class" = local.traffic_controller_resource_classes.queue
  }
}

resource "aws_iam_role" "api_lambda" {
  name = "yaffle-traffic-controller-api-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name                    = local.api_lambda_name
    "yaffle:resource-class" = local.traffic_controller_resource_classes.iam
  }
}

resource "aws_iam_role" "reconcile_lambda" {
  name = "yaffle-traffic-controller-reconcile-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name                    = local.reconcile_lambda_name
    "yaffle:resource-class" = local.traffic_controller_resource_classes.iam
  }
}

resource "aws_iam_role_policy_attachment" "api_lambda_basic" {
  role       = aws_iam_role.api_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "reconcile_lambda_basic" {
  role       = aws_iam_role.reconcile_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api_lambda_runtime" {
  name = "traffic-controller-api-runtime"
  role = aws_iam_role.api_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ]
        Resource = [aws_sqs_queue.reconcile.arn]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          aws_secretsmanager_secret.database_url.arn,
          module.shared.hookdeck_api_key_secret_arn,
          data.aws_secretsmanager_secret.github_app_id.arn,
          data.aws_secretsmanager_secret.github_app_private_key.arn,
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy" "reconcile_lambda_runtime" {
  name = "traffic-controller-reconcile-runtime"
  role = aws_iam_role.reconcile_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility",
        ]
        Resource = [aws_sqs_queue.reconcile.arn]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          aws_secretsmanager_secret.database_url.arn,
          module.shared.hookdeck_api_key_secret_arn,
          data.aws_secretsmanager_secret.github_app_id.arn,
          data.aws_secretsmanager_secret.github_app_private_key.arn,
        ]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.api_lambda_name}"
  retention_in_days = local.is_preview ? 3 : 14

  tags = {
    Name                    = "${local.api_lambda_name}-logs"
    "yaffle:resource-class" = local.traffic_controller_resource_classes.logs
  }
}

resource "aws_cloudwatch_log_group" "reconcile" {
  name              = "/aws/lambda/${local.reconcile_lambda_name}"
  retention_in_days = local.is_preview ? 3 : 14

  tags = {
    Name                    = "${local.reconcile_lambda_name}-logs"
    "yaffle:resource-class" = local.traffic_controller_resource_classes.logs
  }
}

resource "aws_lambda_function" "api" {
  function_name = local.api_lambda_name
  role          = aws_iam_role.api_lambda.arn
  handler       = "api-lambda.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = var.api_lambda_timeout_seconds
  memory_size   = 256
  filename      = "${path.module}/lambda-placeholder.zip"

  environment {
    variables = {
      TRAFFIC_CONTROL_DATABASE_URL_SECRET_ARN = aws_secretsmanager_secret.database_url.arn
      GITHUB_APP_ID_SECRET_ARN                = data.aws_secretsmanager_secret.github_app_id.arn
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN       = data.aws_secretsmanager_secret.github_app_private_key.arn
      HOOKDECK_API_KEY_SECRET_ARN             = module.shared.hookdeck_api_key_secret_arn
      RECONCILE_QUEUE_URL                     = aws_sqs_queue.reconcile.id
      YAFFLE_MONOREPO_OWNER                   = "yaffle-dot-dev"
      YAFFLE_MONOREPO_REPO                    = "yaffle"
      HOOKDECK_GITHUB_SOURCE_ID               = local.hookdeck_github_source_id
      HOOKDECK_GITHUB_SOURCE_NAME             = local.hookdeck_github_source_name
      HOOKDECK_PRODUCTION_DESTINATION_ID      = local.hookdeck_production_destination_id
      HOOKDECK_PRODUCTION_DESTINATION_NAME    = local.hookdeck_production_destination_name
      HOOKDECK_PRODUCTION_CONNECTION_NAME     = local.hookdeck_production_connection_name
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name                    = local.api_lambda_name
    "yaffle:resource-class" = local.traffic_controller_resource_classes.compute
  }
}

resource "aws_lambda_function" "reconcile" {
  function_name = local.reconcile_lambda_name
  role          = aws_iam_role.reconcile_lambda.arn
  handler       = "reconcile-lambda.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = var.reconcile_lambda_timeout_seconds
  memory_size   = 512
  filename      = "${path.module}/lambda-placeholder.zip"

  environment {
    variables = {
      TRAFFIC_CONTROL_DATABASE_URL_SECRET_ARN = aws_secretsmanager_secret.database_url.arn
      GITHUB_APP_ID_SECRET_ARN                = data.aws_secretsmanager_secret.github_app_id.arn
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN       = data.aws_secretsmanager_secret.github_app_private_key.arn
      HOOKDECK_API_KEY_SECRET_ARN             = module.shared.hookdeck_api_key_secret_arn
      RECONCILE_QUEUE_URL                     = aws_sqs_queue.reconcile.id
      YAFFLE_MONOREPO_OWNER                   = "yaffle-dot-dev"
      YAFFLE_MONOREPO_REPO                    = "yaffle"
      HOOKDECK_GITHUB_SOURCE_ID               = local.hookdeck_github_source_id
      HOOKDECK_GITHUB_SOURCE_NAME             = local.hookdeck_github_source_name
      HOOKDECK_PRODUCTION_DESTINATION_ID      = local.hookdeck_production_destination_id
      HOOKDECK_PRODUCTION_DESTINATION_NAME    = local.hookdeck_production_destination_name
      HOOKDECK_PRODUCTION_CONNECTION_NAME     = local.hookdeck_production_connection_name
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name                    = local.reconcile_lambda_name
    "yaffle:resource-class" = local.traffic_controller_resource_classes.compute
  }
}

resource "aws_lambda_event_source_mapping" "reconcile_queue" {
  event_source_arn = aws_sqs_queue.reconcile.arn
  function_name    = aws_lambda_function.reconcile.arn
  batch_size       = 1
}

resource "aws_cloudwatch_event_rule" "reconcile_sweep" {
  name                = "yaffle-traffic-controller-reconcile-sweep-${local.name_suffix}"
  schedule_expression = var.reconcile_schedule_expression
  description         = "Periodic traffic-controller drift reconciliation"
}

resource "aws_cloudwatch_event_target" "reconcile_sweep" {
  rule      = aws_cloudwatch_event_rule.reconcile_sweep.name
  target_id = "traffic-controller-reconcile"
  arn       = aws_lambda_function.reconcile.arn

  input = jsonencode({
    command   = "sweep_drift"
    requestId = "eventbridge-sweep"
  })
}

resource "aws_lambda_permission" "allow_eventbridge_reconcile" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reconcile.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconcile_sweep.arn
}
