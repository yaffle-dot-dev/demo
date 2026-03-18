#!/usr/bin/env bash
# =============================================================================
# Yaffle Runner Entrypoint
# =============================================================================
# Executes a single tofu job in an isolated ECS task.
#
# This script is intentionally minimal and runs in a sandboxed environment
# with no access to Yaffle's internal infrastructure. It receives all inputs
# via presigned URLs and environment variables.
#
# Inputs (via environment variables):
#   WORKSPACE_URL     - Presigned S3 URL to download workspace tarball
#   RESULTS_URL       - Presigned S3 URL to upload results JSON
#   LOGS_URL          - Presigned S3 URL to upload full logs (optional)
#   COMMAND           - tofu command: plan | apply | destroy
#   VARS_JSON         - JSON object of terraform variables
#   TF_VAR_*          - Individual terraform variables (alternative to VARS_JSON)
#   BACKEND_CONFIG    - JSON object with backend configuration
#
# Security notes:
#   - This container has NO access to Yaffle's database or secrets
#   - Provider credentials are passed via TF_VAR_* or assumed IAM role
#   - All URLs are presigned with short expiry (15 min)
#   - Network egress is open (providers need internet access)
#   - Network ingress is blocked (except SSM for ECS Exec if enabled)
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

WORK_DIR="${WORK_DIR:-/workspace}"
COMMAND="${COMMAND:-plan}"
VARS_JSON="${VARS_JSON:-{}}"

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------

log() {
  echo "[yaffle-runner] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

error() {
  echo "[yaffle-runner] $(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: $*" >&2
}

# -----------------------------------------------------------------------------
# Cleanup on exit
# -----------------------------------------------------------------------------

cleanup() {
  local exit_code=$?
  log "Cleaning up..."
  
  # Upload logs if URL provided
  if [[ -n "${LOGS_URL:-}" ]] && [[ -f /tmp/output.log ]]; then
    log "Uploading logs..."
    curl -sSf -X PUT -T /tmp/output.log "$LOGS_URL" || true
  fi
  
  # Clean workspace (defense in depth - container is destroyed anyway)
  rm -rf "$WORK_DIR"/* 2>/dev/null || true
  
  log "Exiting with code $exit_code"
  exit $exit_code
}

trap cleanup EXIT

# -----------------------------------------------------------------------------
# Download workspace
# -----------------------------------------------------------------------------

download_workspace() {
  log "Downloading workspace..."
  
  if [[ -z "${WORKSPACE_URL:-}" ]]; then
    error "WORKSPACE_URL not set"
    exit 1
  fi
  
  mkdir -p "$WORK_DIR"
  cd "$WORK_DIR"
  
  # Download and extract workspace tarball
  if ! curl -sSf "$WORKSPACE_URL" | tar -xz; then
    error "Failed to download workspace"
    exit 1
  fi
  
  log "Workspace downloaded to $WORK_DIR"
  ls -la
}

# -----------------------------------------------------------------------------
# Configure backend
# -----------------------------------------------------------------------------

configure_backend() {
  if [[ -n "${BACKEND_CONFIG:-}" ]]; then
    log "Configuring backend..."
    
    local hostname
    local organization
    local workspace_name
    
    hostname=$(echo "$BACKEND_CONFIG" | jq -r '.hostname')
    organization=$(echo "$BACKEND_CONFIG" | jq -r '.organization')
    workspace_name=$(echo "$BACKEND_CONFIG" | jq -r '.workspaceName')
    
    # Write backend override file
    cat > backend_override.tf <<EOF
terraform {
  cloud {
    hostname     = "${hostname}"
    organization = "${organization}"
    
    workspaces {
      name = "${workspace_name}"
    }
  }
}
EOF
    
    log "Backend configured: ${hostname}/${organization}/${workspace_name}"
    
    # Configure credentials if TFC_TOKEN is provided
    if [[ -n "${TFC_TOKEN:-}" ]]; then
      log "Configuring TFC credentials..."
      
      # Create credentials file for terraform
      mkdir -p ~/.terraform.d
      cat > ~/.terraform.d/credentials.tfrc.json <<EOF
{
  "credentials": {
    "${hostname}": {
      "token": "${TFC_TOKEN}"
    }
  }
}
EOF
      
      # Also set environment variable for TF_TOKEN_<hostname>
      # Replace dots and colons with underscores for env var name
      local token_env_name
      token_env_name="TF_TOKEN_$(echo "$hostname" | tr '.:' '__')"
      export "$token_env_name"="$TFC_TOKEN"
      
      log "Credentials configured for ${hostname}"
    fi
  fi
}

# -----------------------------------------------------------------------------
# Configure variables
# -----------------------------------------------------------------------------

configure_variables() {
  if [[ "$VARS_JSON" != "{}" ]]; then
    log "Writing terraform.tfvars.json..."
    echo "$VARS_JSON" > terraform.tfvars.json
  fi
}

# -----------------------------------------------------------------------------
# Run tofu
# -----------------------------------------------------------------------------

run_tofu() {
  log "Running tofu $COMMAND..."
  
  # Initialize
  log "tofu init..."
  tofu init -input=false 2>&1 | tee -a /tmp/output.log
  
  # Execute command
  case "$COMMAND" in
    plan)
      log "tofu plan..."
      tofu plan -input=false -out=tfplan 2>&1 | tee -a /tmp/output.log
      
      # Generate plan JSON for structured output
      log "Generating plan JSON..."
      tofu show -json tfplan > /tmp/results.json
      ;;
      
    apply)
      log "tofu apply..."
      tofu apply -input=false -auto-approve 2>&1 | tee -a /tmp/output.log
      
      # Capture outputs
      log "Capturing outputs..."
      tofu output -json > /tmp/results.json
      ;;
      
    destroy)
      log "tofu destroy..."
      tofu destroy -input=false -auto-approve 2>&1 | tee -a /tmp/output.log
      
      # Empty results for destroy
      echo '{"destroyed": true}' > /tmp/results.json
      ;;
      
    *)
      error "Unknown command: $COMMAND"
      exit 1
      ;;
  esac
  
  log "tofu $COMMAND completed"
}

# -----------------------------------------------------------------------------
# Upload results
# -----------------------------------------------------------------------------

upload_results() {
  log "Uploading results..."
  
  if [[ -z "${RESULTS_URL:-}" ]]; then
    error "RESULTS_URL not set"
    exit 1
  fi
  
  if [[ ! -f /tmp/results.json ]]; then
    error "No results file found"
    exit 1
  fi
  
  if ! curl -sSf -X PUT -T /tmp/results.json "$RESULTS_URL"; then
    error "Failed to upload results"
    exit 1
  fi
  
  log "Results uploaded successfully"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
  log "Starting yaffle runner"
  log "Command: $COMMAND"
  log "OpenTofu version: $(tofu version | head -1)"
  
  download_workspace
  configure_backend
  configure_variables
  run_tofu
  upload_results
  
  log "Job completed successfully"
}

main "$@"
