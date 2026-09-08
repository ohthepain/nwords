resource "random_password" "db_tenant" {
  length  = 32
  special = false
}

resource "postgresql_role" "tenant" {
  name     = local.tenant_database_name
  login    = true
  password = random_password.db_tenant.result
}

resource "postgresql_database" "tenant" {
  name  = local.tenant_database_name
  owner = postgresql_role.tenant.name
}

resource "postgresql_grant" "tenant_database" {
  database    = postgresql_database.tenant.name
  role        = postgresql_role.tenant.name
  object_type = "database"
  privileges  = ["ALL"]
}
