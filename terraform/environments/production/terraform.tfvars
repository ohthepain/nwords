environment = "production"

network_state_bucket = "nwords-tf-state-REPLACE_AWS_ACCOUNT_ID"

ecs_desired_count = 1
ecs_cpu           = 1024
ecs_memory        = 2048

db_instance_class            = "db.t4g.small"
db_backup_retention_days     = 14
db_multi_az                  = true
db_skip_final_snapshot       = false
db_deletion_protection       = true
uploads_bucket_force_destroy = false
