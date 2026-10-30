output "app_url_azure" {
  value = "https://${azurerm_container_app.main.ingress[0].fqdn}"
}

output "app_url" {
  value = "https://${var.domain}"
}

output "mysql_host" {
  value = azurerm_mysql_flexible_server.main.fqdn
}

# DNS records to create at the registrar (Porkbun) before running bind-domain.sh
output "dns_records" {
  value = {
    a_record   = { host = "@", type = "A", value = azurerm_container_app_environment.main.static_ip_address }
    txt_record = { host = "asuid", type = "TXT", value = nonsensitive(azurerm_container_app.main.custom_domain_verification_id) }
  }
}
