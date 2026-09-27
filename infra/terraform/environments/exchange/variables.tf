variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-south1"
}

variable "member_states" {
  type = map(object({
    service_account = string
    project_number  = string
  }))
  default = {}
}
