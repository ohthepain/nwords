environment = "staging"

shared_state_bucket        = "shared-aws-tf-state-320205321328"
alb_certificate_arn        = "arn:aws:acm:eu-central-1:320205321328:certificate/30fd0800-0e03-4ece-a348-5c5ddbd20256"
alb_listener_rule_priority = 200

ecs_desired_count = 1
ecs_cpu           = 512
ecs_memory        = 2048

uploads_bucket_force_destroy = true

manage_shared_parameters                    = false
seed_shared_parameters_from_secrets_manager = false
