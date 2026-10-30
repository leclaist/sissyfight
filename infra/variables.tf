variable "subscription_id" {
  description = "Azure subscription to deploy into"
  type        = string
}

variable "location" {
  description = "Azure region (East US keeps everything next to the shared container registry)"
  type        = string
  default     = "eastus"
}

variable "acr_name" {
  description = "Existing container registry the image is pulled from"
  type        = string
  default     = "continuationacr"
}

variable "acr_resource_group" {
  description = "Resource group of the existing container registry"
  type        = string
  default     = "continuation-rg"
}

variable "image_tag" {
  description = "Image tag to run on first create. Later deploys change the image with `az containerapp update` (see infra/deploy.sh), which Terraform ignores."
  type        = string
  default     = "latest"
}

variable "domain" {
  description = "Custom domain for the game"
  type        = string
  default     = "sissyfight2026.lol"
}

variable "anthropic_api_key" {
  description = "Anthropic API key for bot players' moves and chat (optional; without it bots play randomly and stay quiet)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "sendgrid_api_key" {
  description = "SendGrid API key for password reset emails (optional; leave empty to disable email)"
  type        = string
  sensitive   = true
  default     = ""
}
