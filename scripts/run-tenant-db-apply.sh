#!/usr/bin/env bash
set -euo pipefail
ENV="${1:-}"
SHARED_AWS_ROOT="${SHARED_AWS_ROOT:-$(cd "$(dirname "$0")/../../shared-aws" 2>/dev/null && pwd || true)}"
export SHARED_AWS_ROOT
exec "$SHARED_AWS_ROOT/scripts/run-tenant-db-apply.sh" "$ENV"
