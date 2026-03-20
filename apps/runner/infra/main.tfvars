# =============================================================================
# Main Environment Variables
# =============================================================================
# These values are used for the main/production environment.
# Preview environments override these via workspace configuration.
# =============================================================================

environment      = "main"
environment_kind = "named"
aws_region       = "us-east-1"

# Runner configuration
runner_cpu    = 512  # 0.5 vCPU
runner_memory = 1024 # 1 GB

# Runner image is pulled from core module's ECR output
