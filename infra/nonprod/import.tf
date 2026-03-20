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
  id       = "rtbassoc-044e2e137c0c1540b"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.public[1]
  id       = "rtbassoc-0da7bbd5d048a90f8"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.private[0]
  id       = "rtbassoc-0ba1703cbd3847e36"
}

import {
  for_each = local.import_main
  to       = module.core.aws_route_table_association.private[1]
  id       = "rtbassoc-0a2e4613c738f0903"
}

import {
  for_each = local.import_main
  to       = module.core.aws_security_group.ecs_instances
  id       = "sg-07b35822b6ca834bf"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_role.ecs_instance
  id       = "yaffle-role-ecs-instance-nonprod-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_instance_profile.ecs_instance
  id       = "yaffle-profile-ecs-instance-nonprod-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_role_policy_attachment.ecs_instance
  id       = "yaffle-role-ecs-instance-nonprod-main-use1/arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_role_policy_attachment.ecs_instance_ssm
  id       = "yaffle-role-ecs-instance-nonprod-main-use1/arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

import {
  for_each = local.import_main
  to       = module.core.aws_launch_template.ecs
  id       = "lt-003b56796de0f23b6"
}

import {
  for_each = local.import_main
  to       = module.core.aws_autoscaling_group.ecs
  id       = "yaffle-ecs-nonprod-main-use1-20260318025426596300000004"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_cluster.main
  id       = "arn:aws:ecs:us-east-1:870923192739:cluster/yaffle-cluster-nonprod-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_capacity_provider.main
  id       = "arn:aws:ecs:us-east-1:870923192739:capacity-provider/yaffle-capacity-nonprod-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_cluster_capacity_providers.main
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
