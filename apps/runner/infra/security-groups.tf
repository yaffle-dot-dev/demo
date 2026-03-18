# =============================================================================
# Security Groups - Runner
# =============================================================================
# Network isolation for the runner.
#
# SECURITY: The runner executes untrusted user terraform code. It must:
#   - Have NO ingress from anywhere (it's not a server)
#   - Have open egress (terraform providers need internet access)
#   - NOT be able to reach internal services (enforced by this SG + other SGs)
# =============================================================================

resource "aws_security_group" "runner" {
  name        = "yaffle-runner-sg-${local.name_suffix}"
  description = "Security group for isolated runner ECS tasks"
  vpc_id      = local.vpc_id

  # NO INGRESS RULES
  # The runner does not accept incoming connections.

  # OPEN EGRESS
  # Terraform providers need to reach various APIs (AWS, GCP, Azure, etc.)
  # We cannot enumerate all possible endpoints, so we allow all egress.
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "yaffle-runner-sg-${local.name_suffix}"
  }
}
