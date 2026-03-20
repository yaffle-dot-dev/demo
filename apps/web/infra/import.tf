locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = aws_iam_role.deploy
  id       = "yaffle-deploy-web-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role.replication
  id       = "yaffle-web-replication-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.deploy_s3
  id       = "yaffle-deploy-web-main-use1:s3-deploy"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.replication
  id       = "yaffle-web-replication-main-use1:yaffle-web-replication-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket.primary
  id       = "yaffle-web-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket.replica
  id       = "yaffle-web-main-usw2"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_versioning.primary
  id       = "yaffle-web-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_versioning.replica
  id       = "yaffle-web-main-usw2"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_server_side_encryption_configuration.primary
  id       = "yaffle-web-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_server_side_encryption_configuration.replica
  id       = "yaffle-web-main-usw2"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_public_access_block.primary
  id       = "yaffle-web-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_public_access_block.replica
  id       = "yaffle-web-main-usw2"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_lifecycle_configuration.primary
  id       = "yaffle-web-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_lifecycle_configuration.replica
  id       = "yaffle-web-main-usw2"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_replication_configuration.primary
  id       = "yaffle-web-main-use1"
}
