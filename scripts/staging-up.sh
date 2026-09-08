#!/usr/bin/env bash
set -euo pipefail
REGION="${AWS_REGION:-eu-central-1}"
PROJECT="${NWORDS_PROJECT_NAME:-nwords}"
ENV=staging
DESIRED="${ECS_DESIRED_COUNT:-1}"
CLUSTER="${PROJECT}-${ENV}-cluster"
SERVICE="${PROJECT}-${ENV}-service"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count "$DESIRED" --force-new-deployment --region "$REGION"
echo "Done."
