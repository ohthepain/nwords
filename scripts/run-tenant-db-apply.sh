#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="${1:-}"
SHARED_AWS_ROOT="${SHARED_AWS_ROOT:-$(cd "$ROOT/../../shared-aws" 2>/dev/null && pwd || cd "$ROOT/../shared-aws" 2>/dev/null && pwd || true)}"
APP_ROOT="$ROOT"
export SHARED_AWS_ROOT
export APP_ROOT
exec "$SHARED_AWS_ROOT/scripts/run-tenant-db-apply.sh" "$ENV"
