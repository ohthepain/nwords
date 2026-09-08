#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED_ROOT="${SHARED_AWS_ROOT:-$(cd "$ROOT/../shared-aws" 2>/dev/null && pwd || true)}"
ENV="${1:-staging}"
TENANT="nwords_${ENV}"
HOST="${2:-}"

case "$ENV" in
  staging) HOST="${HOST:-staging.nwords.live}"; PRIORITY=200 ;;
  production) HOST="${HOST:-nwords.live}"; PRIORITY=210 ;;
  *) echo "Usage: $0 [staging|production] [hostname]" >&2; exit 1 ;;
esac

[[ -n "$SHARED_ROOT" ]] || { echo "Set SHARED_AWS_ROOT" >&2; exit 1; }

cd "$ROOT/terraform"
terraform workspace select "$ENV"

LEGACY_DB_ID="nwords-${ENV}-db"
LEGACY_DB_HOST="$(aws rds describe-db-instances --db-instance-identifier "$LEGACY_DB_ID" --region eu-central-1 --query 'DBInstances[0].Endpoint.Address' --output text 2>/dev/null || true)"
[[ -n "$LEGACY_DB_HOST" && "$LEGACY_DB_HOST" != "None" ]] || LEGACY_DB_HOST="${SOURCE_HOST:-}"
[[ -n "$LEGACY_DB_HOST" ]] || { echo "Legacy RDS not found; set SOURCE_HOST" >&2; exit 1; }

TARGET_PASSWORD="$(terraform output -raw database_url | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')"
SOURCE_PASSWORD="${SOURCE_PASSWORD:?Set SOURCE_PASSWORD to legacy database password}"

"$SHARED_ROOT/scripts/migrate-tenant-db.sh" \
  --tenant "$TENANT" \
  --source-host "$LEGACY_DB_HOST" \
  --source-user nwords \
  --source-password "$SOURCE_PASSWORD" \
  --source-db nwords \
  --target-password "$TARGET_PASSWORD"

"$SHARED_ROOT/scripts/cutover-dns-checklist.sh" "$HOST"
echo "After soak test: ./scripts/decommission-legacy.sh $ENV"
