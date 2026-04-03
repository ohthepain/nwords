# AWS infrastructure (Terraform)

Layout:

1. **`bootstrap/`** — run once locally with the **local** backend. Creates versioned S3 state bucket (`{project}-tf-state-{account_id}`) and DynamoDB table `{project}-terraform-locks`.
2. **`network/`** — shared VPC (2 public AZs, IGW, no NAT), plus a **shared** ECR repository `{project}-app`. Remote state in S3 key `network/terraform.tfstate`.
3. **`/` (this directory)** — application stack per **workspace** `staging` and `production`. Single S3 key `app/terraform.tfstate` with workspace isolation. Reads VPC + ECR from the network state.

## Order of operations

1. `cd terraform/bootstrap && terraform init && terraform apply`
2. Copy `terraform/network/backend.hcl.example` → `terraform/network/backend.hcl` and set `bucket` / `dynamodb_table` from bootstrap outputs.
3. `cd terraform/network && terraform init -backend-config=backend.hcl && terraform apply`
4. In `terraform/environments/staging/terraform.tfvars` and `production/terraform.tfvars`, set `network_state_bucket` to the same bucket as bootstrap (not a secret).
5. Copy `terraform/backend.hcl.example` → `terraform/backend.hcl` with the same bucket and lock table.
6. `./scripts/tf-init.sh`
7. `./scripts/tf-plan.sh staging` then `./scripts/tf-apply.sh staging` (repeat for `production` after `terraform workspace new production` or `select`).

The selected workspace **must** match `environment` in the tfvars file (enforced by a `check` block).

## GitHub Actions / OIDC

### Secrets on environments `staging` and `production`

These are the **only** GitHub secrets required for Terraform-backed deploy jobs (`ci.yml` deploy steps) and for **Staging up/down** workflows (they use `AWS_ROLE_ARN_DEPLOY` only):

| Secret | Purpose |
|--------|---------|
| `AWS_ROLE_ARN_DEPLOY` | IAM role ARN (OIDC trust to `sts.amazonaws.com`, repo/branch conditions as you prefer). |
| `AWS_TF_STATE_BUCKET` | Same value as bootstrap `state_bucket` output. |
| `AWS_TF_LOCK_TABLE` | Same value as bootstrap `lock_table` output (e.g. `nwords-terraform-locks`). |

The deploy role needs at least: ECR push/pull to the shared repo, `ecs:UpdateService` / `Describe*` on the env cluster and service, and read access to Terraform state (S3 objects under the app state prefix + DynamoDB lock table). Narrow ARNs to your account.

Deploy jobs set `TF_VAR_network_state_bucket` and `TF_VAR_environment` so `terraform output` works without committing secrets.

### Application database URL (not a GitHub secret)

`DATABASE_URL` for **running** the app in ECS is created by Terraform in **AWS Secrets Manager** (`terraform/secrets.tf`) and injected into the task definition (`terraform/ecs.tf`). You do **not** add `DATABASE_URL` to GitHub for deploy.

The **`build-and-test`** job in CI uses a **dummy** `DATABASE_URL` in the workflow so `pnpm run build` can load `@nwords/db` (Prisma is initialized at import time). That is unrelated to Terraform secrets.

### Optional repo-level secrets (other workflows)

| Secret | Used by |
|--------|---------|
| `SNYK_TOKEN` | `snyk-security.yml` |
| `ROLLUP_GH_TOKEN`, `OPENAI_API_KEY` | `dependabot-rollup.yml` |

## Container image

- Root **Dockerfile**: multi-stage build, **linux/arm64**, serves TanStack Start (`apps/web` `dist/server/server.js`) on port **3000**.
- Task definition uses image `{ecr_url}:staging` or `:production` matching the workspace.
- ALB health check: **`/api/health`**.

## Database migrations

After RDS is available (and after **staging up** if RDS was stopped), run migrations using `terraform output -raw database_url` (sensitive) or the `DATABASE_URL` key in Secrets Manager. Stopping RDS does not change Terraform state.

## Staging cost control (`scripts/staging-down.sh` / `staging-up.sh`)

- **Down:** ECS desired count `0`, then `aws rds stop-db-instance` for `{project}-staging-db`.
- **Up:** `start-db-instance`, wait `db-instance-available`, then ECS desired count (default `1`, override with `ECS_DESIRED_COUNT`) and `force-new-deployment`.

GitHub Actions: **Staging down** (scheduled + manual) and **Staging up** (manual only) use concurrency group `staging-ops` with `cancel-in-progress: false`.

### RDS stop/start limits (AWS)

- You can stop an instance for up to **7 days**; if not manually started, AWS starts it automatically after that window.
- Stopping is allowed for **Single-AZ** non-SQL Server; **Multi-AZ** production here is started/stopped as a whole (same CLI).
- First start after stop can take several minutes; the ECS `health_check_grace_period_seconds` is set to **300** to allow slow DB wake and app startup.

## Terraform destroy

Secrets use `lifecycle { prevent_destroy = true }`. To destroy an environment, remove those blocks (or `terraform state rm` the secrets) if you accept losing secret metadata, then `terraform workspace select <env> && terraform destroy -var-file=environments/<env>/terraform.tfvars`.

## State lock issues

If a run dies mid-apply, use `./scripts/tf-force-unlock.sh staging <lock-id>` (lock id is printed by Terraform). For corrupted local plugin cache, remove `.terraform/` and re-run `terraform init`.
