# =============================================================================
# Data Sources
# =============================================================================

# Shared infrastructure outputs
data "terraform_remote_state" "shared" {
  backend = "s3"

  config = {
    bucket = "yaffle-state"
    key    = "shared/terraform.tfstate"
    region = "us-east-1"
  }
}

# Latest ECS-optimized AMI
data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

# Availability zones
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  # Shared outputs
  state_bucket_arn = data.terraform_remote_state.shared.outputs.state_bucket_arn
  lock_table_arn   = data.terraform_remote_state.shared.outputs.lock_table_arn
}
