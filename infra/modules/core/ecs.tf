# =============================================================================
# ECS Cluster
# =============================================================================

resource "aws_ecs_cluster" "main" {
  name = "yaffle-cluster-${local.name_suffix}"

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }

  tags = {
    Name = "yaffle-cluster-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# Capacity Provider
# -----------------------------------------------------------------------------

resource "aws_ecs_capacity_provider" "main" {
  name = "yaffle-capacity-${local.name_suffix}"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs.arn
    managed_termination_protection = "ENABLED"

    managed_scaling {
      maximum_scaling_step_size = 2
      minimum_scaling_step_size = 1
      status                    = "ENABLED"
      target_capacity           = 100
    }
  }

  tags = {
    Name = "yaffle-capacity-${local.name_suffix}"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = [aws_ecs_capacity_provider.main.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 1
    base              = var.use_spot ? 0 : 1
  }
}

# -----------------------------------------------------------------------------
# Launch Template
# -----------------------------------------------------------------------------

resource "aws_launch_template" "ecs" {
  name_prefix = "yaffle-ecs-${local.name_suffix}-"
  image_id    = data.aws_ssm_parameter.ecs_ami.value

  # Only set instance_type for on-demand (spot uses mixed instances policy)
  instance_type = var.use_spot ? null : var.instance_types[0]

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs_instance.arn
  }

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.ecs_instances.id]
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    echo "ECS_CLUSTER=${aws_ecs_cluster.main.name}" >> /etc/ecs/ecs.config
    echo "ECS_ENABLE_CONTAINER_METADATA=true" >> /etc/ecs/ecs.config
    %{if var.use_spot}
    echo "ECS_ENABLE_SPOT_INSTANCE_DRAINING=true" >> /etc/ecs/ecs.config
    %{endif}
  EOF
  )

  monitoring {
    enabled = var.container_insights
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "yaffle-ecs-instance-${local.name_suffix}"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Auto Scaling Group
# -----------------------------------------------------------------------------

resource "aws_autoscaling_group" "ecs" {
  name_prefix         = "yaffle-ecs-${local.name_suffix}-"
  vpc_zone_identifier = aws_subnet.private[*].id
  min_size            = var.min_instances
  max_size            = var.max_instances
  desired_capacity    = var.min_instances

  # Use mixed instances policy for spot, simple launch template for on-demand
  dynamic "launch_template" {
    for_each = var.use_spot ? [] : [1]
    content {
      id      = aws_launch_template.ecs.id
      version = "$Latest"
    }
  }

  dynamic "mixed_instances_policy" {
    for_each = var.use_spot ? [1] : []
    content {
      launch_template {
        launch_template_specification {
          launch_template_id = aws_launch_template.ecs.id
          version            = "$Latest"
        }

        dynamic "override" {
          for_each = var.instance_types
          content {
            instance_type = override.value
          }
        }
      }

      instances_distribution {
        on_demand_base_capacity                  = 0
        on_demand_percentage_above_base_capacity = 0
        spot_allocation_strategy                 = "capacity-optimized"
      }
    }
  }

  protect_from_scale_in = true

  health_check_type         = "EC2"
  health_check_grace_period = 300

  dynamic "instance_refresh" {
    for_each = var.use_spot ? [] : [1]
    content {
      strategy = "Rolling"
      preferences {
        min_healthy_percentage = 50
      }
    }
  }

  tag {
    key                 = "Name"
    value               = "yaffle-ecs-instance-${local.name_suffix}"
    propagate_at_launch = true
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Security Group
# -----------------------------------------------------------------------------

resource "aws_security_group" "ecs_instances" {
  name        = "yaffle-sg-ecs-${local.name_suffix}"
  description = "Security group for ECS container instances"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "All traffic from VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "yaffle-sg-ecs-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# IAM
# -----------------------------------------------------------------------------

resource "aws_iam_role" "ecs_instance" {
  name = "yaffle-role-ecs-instance-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "yaffle-role-ecs-instance-${local.name_suffix}"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_instance" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "ecs_instance_ssm" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ecs_instance" {
  name = "yaffle-profile-ecs-instance-${local.name_suffix}"
  role = aws_iam_role.ecs_instance.name
}
