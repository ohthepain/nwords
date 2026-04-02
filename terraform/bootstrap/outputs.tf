output "state_bucket" {
  description = "S3 bucket for Terraform remote state (use in backend.hcl)."
  value       = aws_s3_bucket.tf_state.bucket
}

output "lock_table" {
  description = "DynamoDB table for state locking."
  value       = aws_dynamodb_table.tf_locks.name
}

output "aws_region" {
  value = var.aws_region
}
