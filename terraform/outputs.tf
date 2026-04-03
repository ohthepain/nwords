output "ecr_repository_url" {
  description = "Shared ECR repository URL (image tag = environment name)."
  value       = data.terraform_remote_state.network.outputs.ecr_repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "app_url" {
  description = "HTTPS URL via ALB."
  value       = "https://${aws_lb.main.dns_name}"
}

output "database_url" {
  description = "PostgreSQL URL (same value as Secrets Manager DATABASE_URL)."
  value       = local.database_url
  sensitive   = true
}

output "database_secret_arn" {
  value = aws_secretsmanager_secret.database.arn
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "uploads_bucket" {
  value = aws_s3_bucket.uploads.bucket
}

output "name_prefix" {
  value = local.name_prefix
}

output "rds_identifier" {
  value = aws_db_instance.main.identifier
}

output "google_auth_enabled_ui" {
  description = "Whether the built web UI should show the Google OAuth button."
  value       = var.google_auth_enabled
}
