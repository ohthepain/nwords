#!/usr/bin/env bash
# Start staging RDS, wait until available, then scale ECS back up and recycle tasks.
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
PROJECT="${NWORDS_PROJECT_NAME:-nwords}"
ENV=staging
DESIRED="${ECS_DESIRED_COUNT:-1}"

CLUSTER="${PROJECT}-${ENV}-cluster"
SERVICE="${PROJECT}-${ENV}-service"
DB_ID="${PROJECT}-${ENV}-db"

echo "Starting RDS instance ${DB_ID}..."
aws rds start-db-instance \
	--db-instance-identifier "$DB_ID" \
	--region "$REGION"

echo "Waiting for RDS to become available..."
aws rds wait db-instance-available \
	--db-instance-identifier "$DB_ID" \
	--region "$REGION"

echo "Scaling ECS service ${SERVICE} to desired count ${DESIRED}..."
aws ecs update-service \
	--cluster "$CLUSTER" \
	--service "$SERVICE" \
	--desired-count "$DESIRED" \
	--force-new-deployment \
	--region "$REGION"

echo "Done."
