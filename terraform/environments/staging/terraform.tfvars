environment = "staging"

# Must match the S3 bucket from: terraform -chdir=bootstrap output -raw state_bucket
network_state_bucket = "nwords-terraform-state"

ecs_desired_count = 1
ecs_cpu           = 256
ecs_memory        = 512

db_instance_class            = "db.t4g.micro"
db_backup_retention_days     = 1
db_multi_az                  = false
db_skip_final_snapshot       = true
db_deletion_protection       = false
uploads_bucket_force_destroy = true

# Existing Secrets Manager secrets (provide ARNs for these to enable features).
openai_api_key_secret_arn       = "arn:aws:secretsmanager:eu-central-1:320205321328:secret:nwords_openai_api_key-eoQgrp"
google_client_id_secret_arn     = "arn:aws:secretsmanager:eu-central-1:320205321328:secret:nwords_google_client_id-RWj3Cm"
google_client_secret_secret_arn = "arn:aws:secretsmanager:eu-central-1:320205321328:secret:nwords_google_client_secret-ifjWcg"
