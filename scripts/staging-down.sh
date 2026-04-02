#!/usr/bin/env bash
# Scale staging ECS to 0 and stop RDS. Terraform state is unchanged.
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
PROJECT="${NWORDS_PROJECT_NAME:-nwords}"
ENV=staging

CLUSTER="${PROJECT}-${ENV}-cluster"
SERVICE="${PROJECT}-${ENV}-service"
DB_ID="${PROJECT}-${ENV}-db"

echo "Scaling ECS service ${SERVICE} to desired count 0..."
aws ecs update-service \
	--cluster "$CLUSTER" \
	--service "$SERVICE" \
	--desired-count 0 \
	--region "$REGION"

echo "Stopping RDS instance ${DB_ID}..."
aws rds stop-db-instance \
	--db-instance-identifier "$DB_ID" \
	--region "$REGION"

echo "Done."
