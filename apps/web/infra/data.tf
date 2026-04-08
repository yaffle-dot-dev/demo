# =============================================================================
# Data Sources
# =============================================================================
# References to control-plane infrastructure for shared ALB and networking.
# =============================================================================

module "control_plane" {
  source = "${var.module_registry_host}/yaffle-dot-dev--yaffle/apps--control-plane--infra/yaffle"
}

module "shared" {
  source = "${var.module_registry_host}/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}
