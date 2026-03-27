# =============================================================================
# Data Sources
# =============================================================================
# References to control-plane infrastructure for shared ALB and networking.
# =============================================================================

module "control_plane" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/apps--control-plane--infra/yaffle"
}

module "shared" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}
