output "ecr_repository_url" {
  description = "ECR repository URL (image tag = environment name)."
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "shared_alb_dns_name" {
  description = "Shared ALB DNS name — point tenant hostname CNAME here."
  value       = data.terraform_remote_state.shared.outputs.alb_dns_name
}

output "app_url" {
  description = "Public HTTPS URL for this tenant."
  value       = local.better_auth_url
}

output "better_auth_url" {
  description = "Public app origin passed to ECS as BETTER_AUTH_URL (OAuth redirects, trusted origins)."
  value       = local.better_auth_url
}

output "database_url" {
  description = "PostgreSQL URL (same value as SSM parameter DATABASE_URL)."
  value       = local.database_url
  sensitive   = true
}

output "tenant_database_name" {
  value = local.tenant_database_name
}

output "database_url_parameter_name" {
  description = "SSM Parameter Store name for DATABASE_URL (SecureString)."
  value       = aws_ssm_parameter.database_url.name
}

output "uploads_bucket" {
  value = aws_s3_bucket.uploads.bucket
}

output "name_prefix" {
  value = local.name_prefix
}

output "listener_rule_arn" {
  value = aws_lb_listener_rule.app.arn
}

output "shared_rds_master_secret_arn" {
  description = "Shared RDS master secret ARN (for DB provisioning scripts)."
  value       = data.terraform_remote_state.shared.outputs.rds_master_secret_arn
}

output "google_auth_enabled_ui" {
  description = "Whether the built web UI should show the Google OAuth button."
  value       = var.google_auth_enabled
}
