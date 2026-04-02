locals {
  name_prefix = "${var.project_name}-${var.environment}"
  is_prod     = var.environment == "production"
}

check "workspace_matches_environment" {
  assert {
    condition     = terraform.workspace == var.environment
    error_message = "Terraform workspace (${terraform.workspace}) must match var.environment (${var.environment}). Use: terraform workspace select ${var.environment}"
  }
}

data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = var.network_state_bucket
    key    = var.network_state_key
    region = var.aws_region
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}
