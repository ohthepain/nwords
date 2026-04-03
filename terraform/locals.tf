locals {
  name_prefix = "${var.project_name}-${var.environment}"
  is_prod     = var.environment == "production"

  # Must match the hostname users use in the browser (OAuth redirect_uri = this + /api/auth/callback/google).
  better_auth_url = local.is_prod ? "https://nwords.live" : "https://staging.nwords.live"

  # Single source of truth for ECS Secrets Manager and `terraform output database_url`.
  # sslmode=require matches AWS RDS TLS expectations (some accounts enable rds.force_ssl).
  database_url = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}?sslmode=require"
}

check "workspace_matches_environment" {
  assert {
    condition     = terraform.workspace == var.environment
    error_message = "Terraform workspace (${terraform.workspace}) must match var.environment (${var.environment}). Use: terraform workspace select ${var.environment}"
  }
}

# Network stack is not workspace-scoped; app uses staging/production workspaces.
data "terraform_remote_state" "network" {
  backend   = "s3"
  workspace = "default"

  config = {
    bucket = var.network_state_bucket
    key    = var.network_state_key
    region = var.aws_region
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}
