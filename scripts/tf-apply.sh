#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="${1:?usage: tf-apply.sh staging|production}"
cd "$ROOT/terraform"
terraform workspace select "$ENV" 2>/dev/null || terraform workspace new "$ENV"
terraform apply -var-file="environments/${ENV}/terraform.tfvars" "${@:2}"
