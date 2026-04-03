resource "aws_secretsmanager_secret" "database" {
  name                    = "${local.name_prefix}-database"
  recovery_window_in_days = local.is_prod ? 30 : 0

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({
    DATABASE_URL = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
  })
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name_prefix}-app"
  recovery_window_in_days = local.is_prod ? 30 : 0

  lifecycle {
    prevent_destroy = true
  }
}

resource "random_password" "better_auth_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret_version" "app_initial" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    BETTER_AUTH_SECRET = random_password.better_auth_secret.result
    # The app expects a JSON object with these keys because ECS injects them
    # via `valueFrom = <secret_arn>:<json_key>::`.

    # Third-party API secrets (empty placeholders are OK; features become disabled).
    OPENAI_API_KEY = ""
    GOOGLE_CLIENT_ID = ""
    GOOGLE_CLIENT_SECRET = ""

    # Admin + email plumbing
    AUTH_SUPERADMIN_EMAILS = join(",", var.auth_superadmin_emails)
    SEED_ADMIN_PASSWORD    = var.seed_admin_password
    SES_FROM_EMAIL         = var.ses_from_email
  })
}
