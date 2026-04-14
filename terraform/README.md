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
   Also set `alb_certificate_arn` to an ACM certificate in `eu-central-1` for each environment.
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
- Public traffic is terminated at the ALB on **HTTPS (443)** with **HTTP (80) -> HTTPS redirect**.

## Database migrations

Each ECS task runs **`prisma migrate deploy`** on startup (see `scripts/docker-entrypoint.sh` in the repo) so the schema stays in sync with the image. RDS is not publicly reachable, so migrations are not run from GitHub Actions.

For a **local** or emergency run against the real URL, use `terraform output -raw database_url` (sensitive) or the `DATABASE_URL` key in Secrets Manager, then from the repo: `pnpm db:migrate:deploy`. Stopping RDS does not change Terraform state.

### Initial seed (languages + default admin)

Seeding is **not** automatic on deploy. After the first successful migration, run once per environment (from a machine that can reach RDS, or override the ECS container command to run seed only):

- `pnpm db:seed` with `DATABASE_URL` and `SEED_ADMIN_PASSWORD` set, or
- In the container: `cd /app/packages/db && npx prisma db seed` (requires `SEED_ADMIN_PASSWORD` in the task secrets, already present for ECS).

### Prisma P1010 (“denied access on the database `nwords`”)

That usually means the DB user in `DATABASE_URL` cannot `CONNECT` to `nwords`, or lacks privileges on `public` objects (for example after a restore or a manually created role). Align Secrets Manager with Terraform (`terraform apply` updates the database secret), confirm the URL user matches the RDS master user from Terraform (`db_username`), then run `scripts/fix-rds-db-permissions.sql` as the master user (Part A against `postgres`, Part B against `nwords`). The app `DATABASE_URL` includes `sslmode=require` for RDS.

## Staging cost control (`scripts/staging-down.sh` / `staging-up.sh`)

- **Down:** ECS desired count `0`, then `aws rds stop-db-instance` for `{project}-staging-db`.
- **Up:** `start-db-instance`, wait `db-instance-available`, then ECS desired count (default `1`, override with `ECS_DESIRED_COUNT`) and `force-new-deployment`.

GitHub Actions: **Staging down** (scheduled + manual) and **Staging up** (manual only) use concurrency group `staging-ops` with `cancel-in-progress: false`.

### RDS stop/start limits (AWS)

- You can stop an instance for up to **7 days**; if not manually started, AWS starts it automatically after that window.
- Stopping is allowed for **Single-AZ** non-SQL Server; **Multi-AZ** production here is started/stopped as a whole (same CLI).
- First start after stop can take several minutes; the ECS `health_check_grace_period_seconds` is set to **300** to allow slow DB wake and app startup.

## Amazon SES (password reset and email verification)

The app sends mail via **SES API v2** when `SES_FROM_EMAIL` is set (injected from Secrets Manager as `ses_from_email` in Terraform). The ECS task role includes `ses:SendEmail` and `ses:SendRawEmail` on `*` (same shape as OctaCard).

### Variables

| Variable | Purpose |
|----------|---------|
| `ses_from_email` | Stored in the app secret; must be an address or domain you verified in SES for **eu-central-1**. Use environment-specific senders when useful (e.g. `no-reply@staging.nwords.live` vs `no-reply@nwords.live`). |
| `ses_configuration_set` | If non-empty, Terraform creates `aws_sesv2_configuration_set` (reputation metrics on, TLS **REQUIRE**) and sets ECS env `SES_CONFIGURATION_SET`. Leave empty to skip the resource and send without a configuration set. |
| `ses_domain_name` | If non-empty, Terraform creates `aws_sesv2_email_identity` with Easy DKIM (`RSA_2048_BIT`). Add the **DKIM CNAME** records SES shows (console or `terraform show`) to Route 53 for that zone before expecting good deliverability. |

### Runbook (verify → sandbox → production)

1. **Verify the sending domain or address** in SES (same region as the app, `eu-central-1`). `ses_from_email` must sit on that verified identity.
2. **DKIM**: After `aws_sesv2_email_identity` (if used), publish the three CNAME records; wait for SES to show the identity as healthy.
3. **Sandbox**: New accounts can only mail verified recipients until you request **production access** in SES.
4. **Cutover**: Set `ses_from_email` in tfvars / Secrets Manager, apply Terraform so ECS receives `SES_FROM_EMAIL` and optional `SES_CONFIGURATION_SET`, then redeploy. Without `SES_FROM_EMAIL`, the app logs the intended message instead of calling SES (local dev).

### Troubleshooting

- **Message rejected / not authorized**: Task role missing SES permissions or `SES_FROM_EMAIL` not on a verified identity.
- **Bounces in sandbox**: Recipient must be verified, or move the account out of sandbox.
- **Config set errors**: If `SES_CONFIGURATION_SET` is set, that name must exist in SES; a bad name makes **SESv2** `SendEmail` fail while the older CLI `aws ses send-email` can still succeed (it does not use that set). Leave `SES_CONFIGURATION_SET` empty until the set exists.
- **Password reset “succeeds” but no mail**: Better Auth still returns 200 if sending throws; check app logs for `[auth-email] SES SendEmail failed` or Better Auth’s `Failed to run background task`. Common causes: wrong config set, missing IAM on the task role, or `redirectTo` rejected (fixed locally by trusting both `localhost` and `127.0.0.1`).

## Terraform destroy

Secrets use `lifecycle { prevent_destroy = true }`. To destroy an environment, remove those blocks (or `terraform state rm` the secrets) if you accept losing secret metadata, then `terraform workspace select <env> && terraform destroy -var-file=environments/<env>/terraform.tfvars`.

## State lock issues

If a run dies mid-apply, use `./scripts/tf-force-unlock.sh staging <lock-id>` (lock id is printed by Terraform). For corrupted local plugin cache, remove `.terraform/` and re-run `terraform init`.
