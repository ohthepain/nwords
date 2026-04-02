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

resource "aws_secretsmanager_secret_version" "app_initial" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    PLACEHOLDER = "replace-via-console-or-CI"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
