environment = "staging"

# Must match the S3 bucket from: terraform -chdir=bootstrap output -raw state_bucket
network_state_bucket = "nwords-terraform-state"
alb_certificate_arn  = "arn:aws:acm:eu-central-1:320205321328:certificate/30fd0800-0e03-4ece-a348-5c5ddbd20256"

ecs_desired_count = 1
# 256/512 MiB is too small for Node + prisma migrate deploy + SSR; Fargate often kills with exit 137 (OOM).
ecs_cpu           = 512
ecs_memory        = 2048

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
