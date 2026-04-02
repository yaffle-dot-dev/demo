locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket.workspace_cache
  id       = "yaffle-workspace-cache-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_public_access_block.workspace_cache
  id       = "yaffle-workspace-cache-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_versioning.workspace_cache
  id       = "yaffle-workspace-cache-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_server_side_encryption_configuration.workspace_cache
  id       = "yaffle-workspace-cache-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_lifecycle_configuration.workspace_cache
  id       = "yaffle-workspace-cache-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_versioning.state
  id       = "yaffle-state-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_server_side_encryption_configuration.state
  id       = "yaffle-state-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_lifecycle_configuration.state
  id       = "yaffle-state-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role.ecs_execution
  id       = "yaffle-ecs-exec-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy_attachment.ecs_execution
  id       = "yaffle-ecs-exec-main-use1/arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.ecs_execution_secrets
  id       = "yaffle-ecs-exec-main-use1:secrets-access"
}

import {
  for_each = local.import_main
  to       = aws_iam_role.control_plane_task
  id       = "yaffle-cp-task-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.control_plane_s3
  id       = "yaffle-cp-task-main-use1:s3-state-access"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.control_plane_ecs
  id       = "yaffle-cp-task-main-use1:ecs-runner-access"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.control_plane_secrets
  id       = "yaffle-cp-task-main-use1:secrets-access"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.control_plane_provisioning
  id       = "yaffle-cp-task-main-use1:org-provisioning"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.control_plane_workspace_cache
  id       = "yaffle-cp-task-main-use1:workspace-cache-access"
}

import {
  for_each = local.import_main
  to       = aws_security_group.alb
  id       = "sg-039c8b6ee77c3af0b"
}

import {
  for_each = local.import_main
  to       = aws_security_group.control_plane
  id       = "sg-0d535288064599edd"
}

import {
  for_each = local.import_main
  to       = aws_lb.main
  id       = "arn:aws:elasticloadbalancing:us-east-1:870923192739:loadbalancer/app/yaffle-alb-main-use1/5c513a2b937d6fec"
}

import {
  for_each = local.import_main
  to       = aws_lb_target_group.control_plane
  id       = "arn:aws:elasticloadbalancing:us-east-1:870923192739:targetgroup/yaffle-cp-tg-main-use1/890fcd8001de6803"
}

import {
  for_each = local.import_main
  to       = aws_lb_listener.http
  id       = "arn:aws:elasticloadbalancing:us-east-1:870923192739:listener/app/yaffle-alb-main-use1/5c513a2b937d6fec/05f5f21a1de12298"
}

import {
  for_each = local.import_main
  to       = aws_lb_listener.https
  id       = "arn:aws:elasticloadbalancing:us-east-1:870923192739:listener/app/yaffle-alb-main-use1/5c513a2b937d6fec/d3f1526b472132a2"
}

import {
  for_each = local.import_main
  to       = aws_cloudwatch_log_group.control_plane
  id       = "/ecs/yaffle-cp-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_ecs_task_definition.control_plane
  id       = "arn:aws:ecs:us-east-1:870923192739:task-definition/yaffle-cp-main-use1:3"
}

import {
  for_each = local.import_main
  to       = aws_ecs_service.control_plane
  id       = "yaffle-cluster-production-main-use1/yaffle-cp-main-use1"
}
