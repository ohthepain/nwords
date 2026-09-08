# Migration to shared-aws

See [shared-aws migration runbook](https://github.com/ohthepain/shared-aws/blob/main/docs/MIGRATION_RUNBOOK.md).

## nwords-specific

| Environment | Hostname | ALB priority |
|-------------|----------|--------------|
| staging | staging.nwords.live | 200 |
| production | nwords.live | 210 |

```bash
terraform import aws_ecr_repository.app nwords-app
./scripts/tf-apply.sh staging
SOURCE_PASSWORD='...' ./scripts/migrate-tenant.sh staging
./scripts/decommission-legacy.sh staging
```

Staging parking (`staging-down.sh`) scales ECS only — shared RDS stays up for other tenants.
