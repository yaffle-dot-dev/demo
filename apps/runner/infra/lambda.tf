# =============================================================================
# Lambda Function - Scanner
# =============================================================================
# Zip-based Lambda function for dependency scanning.
# Uses layers for runtime dependencies (git, Tailscale, secrets, Axiom).
#
# Lambda provides ~1 second cold starts vs 30-60 seconds for ECS Fargate.
# =============================================================================

# -----------------------------------------------------------------------------
# Lambda Layer ARN Parameters
# -----------------------------------------------------------------------------
# Terraform owns the SSM parameters; CI publishes layers and overwrites the
# values via `nix run .#publish-scanner-layers`. ignore_changes on value
# prevents Terraform from reverting CI updates.

resource "aws_ssm_parameter" "tailscale_layer_arn" {
  count = var.tailscale_enabled ? 1 : 0

  name  = "/yaffle/scanner/layers/tailscale"
  type  = "String"
  value = "placeholder"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Name = "yaffle-scanner-tailscale-layer-arn"
  }
}

# -----------------------------------------------------------------------------
# Lambda Layers
# -----------------------------------------------------------------------------

locals {
  # AWS-managed secrets extension (Arm64 variant)
  secrets_layer_arn = "arn:aws:lambda:${var.aws_region}:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension-Arm64:17"

  # TODO: Axiom telemetry extension — need to verify correct arm64 layer version
  # axiom_layer_arn = "arn:aws:lambda:${var.aws_region}:694952825951:layer:axiom-extension-arm64:VERSION"

  tailscale_layer_value = var.tailscale_enabled ? aws_ssm_parameter.tailscale_layer_arn[0].value : ""

  # Only include custom layers if they've been published (not still "placeholder")
  scanner_layers = compact(concat(
    [
      local.secrets_layer_arn,
    ],
    local.tailscale_layer_value != "" && local.tailscale_layer_value != "placeholder" ? [local.tailscale_layer_value] : [],
  ))
}

resource "aws_lambda_function" "scanner" {
  function_name = "yaffle-scanner-${local.name_suffix}"
  role          = aws_iam_role.scanner_lambda.arn
  handler       = "scanner-lambda.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  timeout       = 300 # 5 minutes max (large repos)
  memory_size   = 1024

  # Function code is deployed via deploy-scanner.ts (UpdateFunctionCode).
  # Terraform manages the function config but not the code after creation.
  # For initial creation, we use an inline placeholder.
  filename = "${path.module}/scanner-placeholder.zip"

  layers = local.scanner_layers

  environment {
    variables = {
      HOME       = "/tmp"
      # Tailscale auth key (fetched via secrets extension at runtime)
      TAILSCALE_AUTHKEY_SECRET_ARN = var.tailscale_enabled && local.tailscale_runner_authkey_secret_arn != null ? local.tailscale_runner_authkey_secret_arn : ""
      TS_HOSTNAME = "yaffle-scanner-lambda"
      # Axiom telemetry
      AXIOM_TOKEN   = var.axiom_token
      AXIOM_DATASET = "yaffle-scanner"
    }
  }

  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.runner.id]
  }

  # Function code is managed by deploy-scanner.ts, not Terraform after first apply
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name = "yaffle-scanner-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# IAM Role for Scanner Lambda
# -----------------------------------------------------------------------------

resource "aws_iam_role" "scanner_lambda" {
  name = "yaffle-scanner-lambda-${local.name_suffix}"

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
    Name = "yaffle-scanner-lambda-${local.name_suffix}"
  }
}

resource "aws_iam_role_policy_attachment" "scanner_lambda_basic" {
  role       = aws_iam_role.scanner_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "scanner_lambda_vpc" {
  role       = aws_iam_role.scanner_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Allow reading the Tailscale auth key from Secrets Manager
resource "aws_iam_role_policy" "scanner_lambda_tailscale_secret" {
  count = var.tailscale_enabled && local.tailscale_runner_authkey_secret_arn != null ? 1 : 0

  name = "tailscale-secret-access"
  role = aws_iam_role.scanner_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          local.tailscale_runner_authkey_secret_arn,
        ]
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "scanner" {
  name              = "/aws/lambda/yaffle-scanner-${local.name_suffix}"
  retention_in_days = local.is_preview ? 3 : 14

  tags = {
    Name = "yaffle-scanner-logs-${local.name_suffix}"
  }
}
