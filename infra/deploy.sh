#!/usr/bin/env bash
# Build the image in Azure Container Registry (native linux/amd64) and roll the
# container app onto it. Run from anywhere: infra/deploy.sh [tag]
set -euo pipefail

ACR=continuationacr
RG=sissyfight-rg
APP=sissyfight
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "warning: working tree has uncommitted changes; they will be included in the image" >&2
fi

az acr build --registry "$ACR" --image "sissyfight:$TAG" --image sissyfight:latest "$REPO_ROOT"

# the app may not exist yet on the very first run (terraform apply creates it)
if az containerapp show --name "$APP" --resource-group "$RG" >/dev/null 2>&1; then
  az containerapp update --name "$APP" --resource-group "$RG" \
    --image "$ACR.azurecr.io/sissyfight:$TAG" --query properties.latestRevisionName -o tsv
fi
