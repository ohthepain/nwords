provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

provider "postgresql" {
  host            = data.terraform_remote_state.shared.outputs.rds_endpoint
  port            = data.terraform_remote_state.shared.outputs.rds_port
  username        = local.shared_rds_master.username
  password        = local.shared_rds_master.password
  sslmode         = "require"
  superuser       = true
  connect_timeout = 15
}
