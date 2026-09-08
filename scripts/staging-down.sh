#!/usr/bin/env bash
set -euo pipefail
REGION="${AWS_REGION:-eu-central-1}"
PROJECT="${NWORDS_PROJECT_NAME:-nwords}"
ENV=staging
CLUSTER="${PROJECT}-${ENV}-cluster"
SERVICE="${PROJECT}-${ENV}-service"
echo "Scaling ECS service ${SERVICE} to desired count 0..."
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 --region "$REGION"
echo "Done. Shared RDS is not stopped (other tenants may depend on it)."
