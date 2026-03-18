# =============================================================================
# Security Groups
# =============================================================================
# Security groups for the control plane ALB and ECS tasks.
# =============================================================================

# -----------------------------------------------------------------------------
# ALB Security Group
# -----------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "yaffle-alb-sg-${local.name_suffix}"
  description = "Security group for control plane ALB"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP from anywhere (redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "yaffle-alb-sg-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# Control Plane Security Group
# -----------------------------------------------------------------------------

resource "aws_security_group" "control_plane" {
  name        = "yaffle-cp-sg-${local.name_suffix}"
  description = "Security group for control plane ECS tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "HTTP from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "yaffle-cp-sg-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# TF Runner Security Group
# -----------------------------------------------------------------------------
# Runner security group is managed by apps/runner/infra.
