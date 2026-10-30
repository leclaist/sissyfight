#!/usr/bin/env bash
# One-time setup so GitHub Actions can deploy with OpenID Connect (no stored
# Azure secret). Creates an app registration that only trusts workflows on
# master of leclaist/sissyfight, grants it Contributor on sissyfight-rg and on
# the shared registry (az acr build needs that), and sets the repo variables
# the Deploy workflow reads.
set -euo pipefail

REPO=leclaist/sissyfight
NAME=sissyfight-github-deploy
SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)

APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$NAME" --query appId -o tsv)
  az ad sp create --id "$APP_ID" --query id -o tsv >/dev/null
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"github-master\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:$REPO:ref:refs/heads/master\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" --query subject -o tsv
fi
echo "app registration: $APP_ID"

# new service principals can take a moment to be visible to role assignment
for scope in "/subscriptions/$SUB/resourceGroups/sissyfight-rg" "$(az acr show -n continuationacr --query id -o tsv)"; do
  for i in 1 2 3 4 5 6; do
    az role assignment create --assignee "$APP_ID" --role Contributor --scope "$scope" --query scope -o tsv && break
    sleep 10
  done
done

gh variable set AZURE_CLIENT_ID --repo "$REPO" --body "$APP_ID"
gh variable set AZURE_TENANT_ID --repo "$REPO" --body "$TENANT"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUB"
echo "done: pushes to master now deploy after CI passes"
