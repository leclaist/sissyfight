# SiSSYFiGHT on Azure Container Apps + Azure Database for MySQL.
#
# Game rooms live in the server's memory, so the app runs exactly one replica.
# The custom domain is bound outside Terraform (see infra/bind-domain.sh),
# because the managed certificate can only be issued once DNS points here.

locals {
  name = "sissyfight"
  tags = { app = "sissyfight" }
}

resource "azurerm_resource_group" "main" {
  name     = "${local.name}-rg"
  location = var.location
  tags     = local.tags
}

# ---------------------------------------------------------------------------
# Image pulls: managed identity with AcrPull on the shared registry
# ---------------------------------------------------------------------------

data "azurerm_container_registry" "shared" {
  name                = var.acr_name
  resource_group_name = var.acr_resource_group
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name}-identity"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = data.azurerm_container_registry.shared.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ---------------------------------------------------------------------------
# MySQL
# ---------------------------------------------------------------------------

resource "random_password" "mysql_admin" {
  length  = 32
  special = false # keeps DATABASE_URL free of characters that need escaping
}

resource "random_string" "mysql_suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_mysql_flexible_server" "main" {
  name                   = "${local.name}-mysql-${random_string.mysql_suffix.result}" # globally unique
  location               = azurerm_resource_group.main.location
  resource_group_name    = azurerm_resource_group.main.name
  administrator_login    = "sfadmin"
  administrator_password = random_password.mysql_admin.result
  sku_name               = "B_Standard_B1ms"
  version                = "8.4"
  backup_retention_days  = 7

  storage {
    size_gb           = 20
    auto_grow_enabled = true
  }

  tags = local.tags

  lifecycle {
    # Azure picks the zone; don't fight it on later applies
    ignore_changes = [zone]
  }
}

resource "azurerm_mysql_flexible_database" "app" {
  name                = local.name
  resource_group_name = azurerm_resource_group.main.name
  server_name         = azurerm_mysql_flexible_server.main.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_0900_ai_ci"
}

# Container Apps on the consumption plan have no fixed outbound IPs, so allow
# connections from Azure services. Access still needs the password, and the
# server requires TLS (require_secure_transport is on by default).
resource "azurerm_mysql_flexible_server_firewall_rule" "azure_services" {
  name                = "AllowAzureServices"
  resource_group_name = azurerm_resource_group.main.name
  server_name         = azurerm_mysql_flexible_server.main.name
  start_ip_address    = "0.0.0.0"
  end_ip_address      = "0.0.0.0"
}

# ---------------------------------------------------------------------------
# Container Apps
# ---------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${local.name}-logs"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_container_app_environment" "main" {
  name                       = "${local.name}-env"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = local.tags

  # Azure adds the serverless Consumption profile to every new environment
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "random_password" "session_secret" {
  length  = 48
  special = false
}

locals {
  database_url = "mysql://${azurerm_mysql_flexible_server.main.administrator_login}:${random_password.mysql_admin.result}@${azurerm_mysql_flexible_server.main.fqdn}:3306/${azurerm_mysql_flexible_database.app.name}"
}

resource "azurerm_container_app" "main" {
  name                         = local.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = data.azurerm_container_registry.shared.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  secret {
    name  = "session-secret"
    value = random_password.session_secret.result
  }

  dynamic "secret" {
    for_each = var.anthropic_api_key != "" ? [1] : []
    content {
      name  = "anthropic-api-key"
      value = var.anthropic_api_key
    }
  }

  dynamic "secret" {
    for_each = var.sendgrid_api_key != "" ? [1] : []
    content {
      name  = "sendgrid-api-key"
      value = var.sendgrid_api_key
    }
  }

  template {
    # exactly one replica: game state is in memory
    min_replicas = 1
    max_replicas = 1

    container {
      name   = local.name
      image  = "${data.azurerm_container_registry.shared.login_server}/${local.name}:${var.image_tag}"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PUBLIC_URL"
        value = "https://${var.domain}"
      }
      env {
        name  = "DB_SSL"
        value = "true"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name        = "SESSION_SECRET"
        secret_name = "session-secret"
      }
      dynamic "env" {
        for_each = var.anthropic_api_key != "" ? [1] : []
        content {
          name        = "ANTHROPIC_API_KEY"
          secret_name = "anthropic-api-key"
        }
      }
      dynamic "env" {
        for_each = var.sendgrid_api_key != "" ? [1] : []
        content {
          name        = "SENDGRID_API_KEY"
          secret_name = "sendgrid-api-key"
        }
      }

      startup_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = 3000
        interval_seconds        = 5
        failure_count_threshold = 12 # first boot also runs db:setup
      }
      liveness_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = 3000
        interval_seconds        = 30
        failure_count_threshold = 3
      }
      readiness_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = 3000
        interval_seconds        = 10
        failure_count_threshold = 3
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto" # HTTP/1.1 with WebSocket upgrades for sockjs

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  lifecycle {
    # deploys update the image with `az containerapp update` (infra/deploy.sh)
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [azurerm_role_assignment.acr_pull]
}
