locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = module.core.aws_vpc.main
  id       = "vpc-04803ab5c6e155411"
}

import {
  for_each = local.import_main
  to       = module.core.aws_internet_gateway.main
  id       = "igw-024630522942ef107"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.public[0]
  id       = "subnet-0368cb15c42880e66"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.public[1]
  id       = "subnet-0eb279aa37b2356be"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.private[0]
  id       = "subnet-08fa6d850b87acd11"
}

import {
  for_each = local.import_main
  to       = module.core.aws_subnet.private[1]
  id       = "subnet-03343fc0f7d10950c"
}

import {
  for_each = local.import_main
  to       = module.core.aws_eip.nat[0]
  id       = "eipalloc-04b3598dc65b495b9"
}

import {
  for_each = local.import_main
  to       = module.core.aws_eip.nat[1]
  id       = "eipalloc-09855471d455edc7b"
}

import {
  for_each = local.import_main
  to       = module.core.aws_nat_gateway.main[0]
  id       = "nat-0eb044066ca0381b7"
}

import {
  for_each = local.import_main
  to       = module.core.aws_nat_gateway.main[1]
  id       = "nat-01023f0b7fd7a9ed5"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table.public
  id       = "rtb-0fd60ab359990356c"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table.private[0]
  id       = "rtb-0400a29c7740fabb6"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table.private[1]
  id       = "rtb-06c86bfdaef3aebe0"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.public[0]
  id       = "subnet-0368cb15c42880e66/rtb-0fd60ab359990356c"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.public[1]
  id       = "subnet-0eb279aa37b2356be/rtb-0fd60ab359990356c"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.private[0]
  id       = "subnet-08fa6d850b87acd11/rtb-0400a29c7740fabb6"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.private[1]
  id       = "subnet-03343fc0f7d10950c/rtb-06c86bfdaef3aebe0"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_cluster.main
  id       = "yaffle-cluster-production-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_repository.control_plane
  id       = "yaffle-control-plane-production"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_repository.runner
  id       = "yaffle-runner-production"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_lifecycle_policy.control_plane
  id       = "yaffle-control-plane-production"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecr_lifecycle_policy.runner
  id       = "yaffle-runner-production"
}
