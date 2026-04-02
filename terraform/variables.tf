variable "project_name" {
  type    = string
  default = "nwords"
}

variable "environment" {
  type        = string
  description = "Must match the selected Terraform workspace (staging | production)."
}

variable "aws_region" {
  type    = string
  default = "eu-central-1"
}

variable "network_state_bucket" {
  type        = string
  description = "S3 bucket holding the network stack state (same as bootstrap output)."
}

variable "network_state_key" {
  type    = string
  default = "network/terraform.tfstate"
}

variable "ecs_desired_count" {
  type    = number
  default = 1
}

variable "ecs_cpu" {
  type    = number
  default = 512
}

variable "ecs_memory" {
  type    = number
  default = 1024
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "health_check_path" {
  type    = string
  default = "/api/health"
}

variable "db_name" {
  type    = string
  default = "nwords"
}

variable "db_username" {
  type    = string
  default = "nwords"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_backup_retention_days" {
  type    = number
  default = 1
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_skip_final_snapshot" {
  type    = bool
  default = true
}

variable "db_deletion_protection" {
  type    = bool
  default = false
}

variable "uploads_bucket_force_destroy" {
  type        = bool
  description = "Allow Terraform to delete uploads bucket even if non-empty (use false in production)."
  default     = false
}

variable "uploads_cors_allowed_origins" {
  type        = list(string)
  description = "CORS allowed origins for the uploads bucket (set to your app URL in production)."
  default     = ["*"]
}
