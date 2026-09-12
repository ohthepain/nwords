resource "random_password" "better_auth_secret" {
  length  = 64
  special = false
}

locals {
  shared_param_openai_name   = "nwords_openai_api_key"
  shared_param_google_id     = "nwords_google_client_id"
  shared_param_google_secret = "nwords_google_client_secret"

  openai_api_key_seed = var.openai_api_key != "" ? var.openai_api_key : (
    var.manage_shared_parameters && var.seed_shared_parameters_from_secrets_manager ?
    try(data.aws_secretsmanager_secret_version.migrate_openai_api_key[0].secret_string, "") : ""
  )
  google_client_id_seed = var.google_client_id != "" ? var.google_client_id : (
    var.manage_shared_parameters && var.seed_shared_parameters_from_secrets_manager ?
    try(data.aws_secretsmanager_secret_version.migrate_google_client_id[0].secret_string, "") : ""
  )
  google_client_secret_seed = var.google_client_secret != "" ? var.google_client_secret : (
    var.manage_shared_parameters && var.seed_shared_parameters_from_secrets_manager ?
    try(data.aws_secretsmanager_secret_version.migrate_google_client_secret[0].secret_string, "") : ""
  )

  ssm_openai_api_key_arn       = var.manage_shared_parameters ? aws_ssm_parameter.openai_api_key[0].arn : data.aws_ssm_parameter.openai_api_key[0].arn
  ssm_google_client_id_arn     = var.manage_shared_parameters ? aws_ssm_parameter.google_client_id[0].arn : data.aws_ssm_parameter.google_client_id[0].arn
  ssm_google_client_secret_arn = var.manage_shared_parameters ? aws_ssm_parameter.google_client_secret[0].arn : data.aws_ssm_parameter.google_client_secret[0].arn
}

data "aws_secretsmanager_secret_version" "migrate_openai_api_key" {
  count     = var.manage_shared_parameters && var.seed_shared_parameters_from_secrets_manager && var.openai_api_key == "" ? 1 : 0
  secret_id = local.shared_param_openai_name
}

data "aws_secretsmanager_secret_version" "migrate_google_client_id" {
  count     = var.manage_shared_parameters && var.seed_shared_parameters_from_secrets_manager && var.google_client_id == "" ? 1 : 0
  secret_id = local.shared_param_google_id
}

data "aws_secretsmanager_secret_version" "migrate_google_client_secret" {
  count     = var.manage_shared_parameters && var.seed_shared_parameters_from_secrets_manager && var.google_client_secret == "" ? 1 : 0
  secret_id = local.shared_param_google_secret
}

resource "aws_ssm_parameter" "openai_api_key" {
  count = var.manage_shared_parameters ? 1 : 0

  name  = local.shared_param_openai_name
  type  = "SecureString"
  value = local.openai_api_key_seed

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "google_client_id" {
  count = var.manage_shared_parameters ? 1 : 0

  name  = local.shared_param_google_id
  type  = "SecureString"
  value = local.google_client_id_seed

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "google_client_secret" {
  count = var.manage_shared_parameters ? 1 : 0

  name  = local.shared_param_google_secret
  type  = "SecureString"
  value = local.google_client_secret_seed

  lifecycle {
    ignore_changes = [value]
  }
}

data "aws_ssm_parameter" "openai_api_key" {
  count = var.manage_shared_parameters ? 0 : 1
  name  = local.shared_param_openai_name
}

data "aws_ssm_parameter" "google_client_id" {
  count = var.manage_shared_parameters ? 0 : 1
  name  = local.shared_param_google_id
}

data "aws_ssm_parameter" "google_client_secret" {
  count = var.manage_shared_parameters ? 0 : 1
  name  = local.shared_param_google_secret
}

resource "aws_ssm_parameter" "database_url" {
  name  = "${local.name_prefix}-DATABASE_URL"
  type  = "SecureString"
  value = local.database_url
}

resource "aws_ssm_parameter" "better_auth_secret" {
  name  = "${local.name_prefix}-BETTER_AUTH_SECRET"
  type  = "SecureString"
  value = random_password.better_auth_secret.result
}

resource "aws_ssm_parameter" "auth_superadmin_emails" {
  name  = "${local.name_prefix}-AUTH_SUPERADMIN_EMAILS"
  type  = "SecureString"
  value = join(",", var.auth_superadmin_emails)
}

resource "aws_ssm_parameter" "seed_admin_password" {
  name  = "${local.name_prefix}-SEED_ADMIN_PASSWORD"
  type  = "SecureString"
  value = var.seed_admin_password
}

resource "aws_ssm_parameter" "ses_from_email" {
  name  = "${local.name_prefix}-SES_FROM_EMAIL"
  type  = "SecureString"
  value = var.ses_from_email
}
