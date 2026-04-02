#!/usr/bin/env bash
# Usage: tf-force-unlock.sh staging|production <lock-id>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="${1:?usage: tf-force-unlock.sh staging|production LOCK_ID}"
LOCK="${2:?usage: tf-force-unlock.sh staging|production LOCK_ID}"
cd "$ROOT/terraform"
terraform workspace select "$ENV"
terraform force-unlock -force "$LOCK"
