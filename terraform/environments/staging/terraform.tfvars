environment = "staging"

# Must match the S3 bucket from: terraform -chdir=bootstrap output -raw state_bucket
network_state_bucket = "nwords-tf-state-REPLACE_AWS_ACCOUNT_ID"

ecs_desired_count = 1
ecs_cpu           = 256
ecs_memory        = 512

db_instance_class            = "db.t4g.micro"
db_backup_retention_days     = 1
db_multi_az                  = false
db_skip_final_snapshot       = true
db_deletion_protection       = false
uploads_bucket_force_destroy = true
