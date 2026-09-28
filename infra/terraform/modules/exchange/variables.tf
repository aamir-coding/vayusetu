variable "project_id" {
  type        = string
  description = "The National Exchange project (e.g. vayusetu-exchange-dev)."
}

variable "location" {
  type    = string
  default = "asia-south1"
}

variable "labels" {
  type    = map(string)
  default = { app = "vayusetu", component = "federation-exchange" }
}

variable "member_states" {
  description = "State code -> that deployment's federation-service SA (state-deployment output federation_identity) and its project NUMBER."
  type = map(object({
    service_account = string
    project_number  = string
  }))
  default = {}

  validation {
    condition     = alltrue([for k, v in var.member_states : can(regex("^[A-Z]{2}$", k)) && endswith(v.service_account, ".iam.gserviceaccount.com")])
    error_message = "Keys are 2-letter LGD state codes; service_account is a service-account email."
  }
}

variable "portal_site_id" {
  description = "Firebase Hosting site for the national landing page: https://<id>.web.app. Globally unique across Firebase."
  type        = string
  default     = "vayusetu"
}
