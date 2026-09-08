#!/usr/bin/env bash
set -euo pipefail
ENV="${1:-}"
[[ -n "$ENV" ]] || { echo "Usage: $0 <staging|production>" >&2; exit 1; }
REGION="${AWS_REGION:-eu-central-1}"
PROJECT="${NWORDS_PROJECT_NAME:-nwords}"
LEGACY_DB_ID="${PROJECT}-${ENV}-db"
LEGACY_ALB_NAME="${PROJECT}-${ENV}-alb"
read -r -p "Delete legacy ${PROJECT} ${ENV} RDS and ALB? [y/N] " CONFIRM
[[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || exit 0
ALB_ARN="$(aws elbv2 describe-load-balancers --names "$LEGACY_ALB_NAME" --region "$REGION" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)"
[[ -z "$ALB_ARN" || "$ALB_ARN" == "None" ]] || aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN" --region "$REGION"
if aws rds describe-db-instances --db-instance-identifier "$LEGACY_DB_ID" --region "$REGION" >/dev/null 2>&1; then
  aws rds delete-db-instance --db-instance-identifier "$LEGACY_DB_ID" --skip-final-snapshot --region "$REGION"
fi
echo "Done."
