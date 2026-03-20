locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_iam_role.deploy
  id       = "yaffle-deploy-marketing-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_iam_role.replication
  id       = "yaffle-marketing-replication-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_iam_role_policy.deploy_s3
  id       = "yaffle-deploy-marketing-main-use1:s3-deploy"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_iam_role_policy.replication
  id       = "yaffle-marketing-replication-main-use1:yaffle-marketing-replication-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket.primary
  id       = "yaffle-marketing-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket.replica
  id       = "yaffle-marketing-main-usw2"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_versioning.primary
  id       = "yaffle-marketing-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_versioning.replica
  id       = "yaffle-marketing-main-usw2"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_server_side_encryption_configuration.primary
  id       = "yaffle-marketing-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_server_side_encryption_configuration.replica
  id       = "yaffle-marketing-main-usw2"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_public_access_block.primary
  id       = "yaffle-marketing-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_public_access_block.replica
  id       = "yaffle-marketing-main-usw2"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_lifecycle_configuration.primary
  id       = "yaffle-marketing-main-use1"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_lifecycle_configuration.replica
  id       = "yaffle-marketing-main-usw2"
}

import {
  for_each = local.import_main
  to       = module.static_site.aws_s3_bucket_replication_configuration.primary
  id       = "yaffle-marketing-main-use1"
}
