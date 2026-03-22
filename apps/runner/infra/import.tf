locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = aws_iam_role.runner_execution
  id       = "yaffle-runner-exec-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy_attachment.runner_execution
  id       = "yaffle-runner-exec-main-use1/arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.runner_execution_tailscale_secret[0]
  id       = "yaffle-runner-exec-main-use1:tailscale-secret-access"
}

import {
  for_each = local.import_main
  to       = aws_iam_role.runner_task
  id       = "yaffle-runner-task-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.runner_assume_org_roles
  id       = "yaffle-runner-task-main-use1:assume-org-roles"
}

import {
  for_each = local.import_main
  to       = aws_security_group.runner
  id       = "sg-005ac498998420a3f"
}

import {
  for_each = local.import_main
  to       = aws_cloudwatch_log_group.runner
  id       = "/ecs/yaffle-runner-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_ecs_task_definition.runner
  id       = "arn:aws:ecs:us-east-1:870923192739:task-definition/yaffle-runner-main-use1:3"
}
