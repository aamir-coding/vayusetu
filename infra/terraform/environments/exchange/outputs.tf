output "dataset" { value = module.exchange.dataset }
output "vertex_agent" { value = module.exchange.vertex_agent }

output "portal_url" {
  description = "The national landing page."
  value       = module.exchange.portal_url
}
