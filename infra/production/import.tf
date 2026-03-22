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
  to       = module.core.aws_security_group.ecs_instances
  id       = "sg-04542c32e257a32e6"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_role.ecs_instance
  id       = "yaffle-role-ecs-instance-production-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_instance_profile.ecs_instance
  id       = "yaffle-profile-ecs-instance-production-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_role_policy_attachment.ecs_instance
  id       = "yaffle-role-ecs-instance-production-main-use1/arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

import {
  for_each = local.import_main
  to       = module.core.aws_iam_role_policy_attachment.ecs_instance_ssm
  id       = "yaffle-role-ecs-instance-production-main-use1/arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

import {
  for_each = local.import_main
  to       = module.core.aws_launch_template.ecs
  id       = "lt-09cbcb01f655b9f00"
}

import {
  for_each = local.import_main
  to       = module.core.aws_autoscaling_group.ecs
  id       = "yaffle-ecs-production-main-use1-20260318025321997900000004"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_cluster.main
  id       = "yaffle-cluster-production-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_capacity_provider.main
  id       = "arn:aws:ecs:us-east-1:870923192739:capacity-provider/yaffle-capacity-production-main-use1"
}

import {
  for_each = local.import_main
  to       = module.core.aws_ecs_cluster_capacity_providers.main
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
