# =============================================================================
# Security Groups - Web App
# =============================================================================

resource "aws_security_group" "web" {
  name        = "yaffle-web-sg-${local.name_suffix}"
  description = "Security group for web app ECS tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "HTTP from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [local.alb_security_group_id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "yaffle-web-sg-${local.name_suffix}"
  }
}
