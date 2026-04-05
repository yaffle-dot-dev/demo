locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = module.core.aws_vpc.main
  id       = "vpc-0237ef3904ba8e526"
}

import {
  for_each = local.import_main
  to       = module.core.aws_internet_gateway.main
  id       = "igw-017a062691a1563d0"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.public[0]
  id       = "subnet-0685a1152b6a8c91e"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.public[1]
  id       = "subnet-0a3d6409c562f49d8"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.private[0]
  id       = "subnet-0b9e4aa7ded90404f"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.private[1]
  id       = "subnet-03493f7df484e11a6"
}

import {
  for_each = local.import_main
  to       = module.core.aws_eip.nat[0]
  id       = "eipalloc-0f3dc05e0af9b5988"
}

import {
  for_each = local.import_main
  to       = module.core.aws_nat_gateway.main[0]
  id       = "nat-0e00209a4f18fed89"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table.public
  id       = "rtb-0b19954d65458bd08"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table.private[0]
  id       = "rtb-0d143df2ef720b4f1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.public[0]
  id       = "subnet-0685a1152b6a8c91e/rtb-0b19954d65458bd08"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.public[1]
  id       = "subnet-0a3d6409c562f49d8/rtb-0b19954d65458bd08"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.private[0]
  id       = "subnet-0b9e4aa7ded90404f/rtb-0d143df2ef720b4f1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.private[1]
  id       = "subnet-03493f7df484e11a6/rtb-0d143df2ef720b4f1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_cluster.main
  id       = "yaffle-cluster-nonprod-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_repository.control_plane
  id       = "yaffle-control-plane-nonprod"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_repository.runner
  id       = "yaffle-runner-nonprod"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_lifecycle_policy.control_plane
  id       = "yaffle-control-plane-nonprod"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_lifecycle_policy.runner
  id       = "yaffle-runner-nonprod"
}
