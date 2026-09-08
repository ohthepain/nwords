environment = "production"

shared_state_bucket = "shared-aws-tf-state-320205321328"
alb_certificate_arn = "arn:aws:acm:eu-central-1:320205321328:certificate/558d0af5-a4b8-49b1-9449-60d21a8906e4"
alb_listener_rule_priority = 210

ecs_desired_count = 1
ecs_cpu           = 1024
ecs_memory        = 2048

uploads_bucket_force_destroy = false

openai_api_key_secret_arn       = "arn:aws:secretsmanager:eu-central-1:320205321328:secret:nwords_openai_api_key-eoQgrp"
google_client_id_secret_arn     = "arn:aws:secretsmanager:eu-central-1:320205321328:secret:nwords_google_client_id-RWj3Cm"
google_client_secret_secret_arn = "arn:aws:secretsmanager:eu-central-1:320205321328:secret:nwords_google_client_secret-ifjWcg"
