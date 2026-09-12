environment = "production"

shared_state_bucket        = "shared-aws-tf-state-320205321328"
alb_certificate_arn        = "arn:aws:acm:eu-central-1:320205321328:certificate/558d0af5-a4b8-49b1-9449-60d21a8906e4"
alb_listener_rule_priority = 210

ecs_desired_count = 1
ecs_cpu           = 1024
ecs_memory        = 2048

uploads_bucket_force_destroy = false

manage_shared_parameters                    = true
seed_shared_parameters_from_secrets_manager = false
