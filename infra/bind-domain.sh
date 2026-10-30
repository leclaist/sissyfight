#!/usr/bin/env bash
# Bind the custom domain with a free managed certificate. Run once, after the
# DNS records from `terraform output dns_records` exist at the registrar.
set -euo pipefail

RG=sissyfight-rg
APP=sissyfight
ENV=sissyfight-env
DOMAIN="${1:-sissyfight2026.lol}"

az containerapp hostname add --hostname "$DOMAIN" --name "$APP" --resource-group "$RG"
az containerapp hostname bind --hostname "$DOMAIN" --name "$APP" --resource-group "$RG" \
  --environment "$ENV" --validation-method HTTP
