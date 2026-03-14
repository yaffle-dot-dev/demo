# Terraform Variables

Yaffle injects variables into every Terraform run, providing context about the current environment and run.

## Available Variables

| Variable | Type | Description |
|----------|------|-------------|
| `var.environment` | `string` | Environment name (e.g., `"main"`, `"staging"`, `"pr-123"`) |
| `var.environment_kind` | `string` | Either `"named"` or `"transient"` |
| `var.org` | `string` | Organization slug |
| `var.repo` | `string` | Repository name |
| `var.workspace_path` | `string` | Workspace path (e.g., `"apps/control-plane/infra"`) |
| `var.branch` | `string` | Git branch name |
| `var.commit_sha` | `string` | Git commit SHA (full 40 characters) |
| `var.pr_number` | `number` | Pull request number (only set for transient PR environments) |

## Declaring Variables

To use these variables, declare them in your Terraform configuration:

```hcl
variable "environment" {
  description = "Environment name (e.g., main, staging, pr-123)"
  type        = string
}

variable "environment_kind" {
  description = "Environment kind: named or transient"
  type        = string
}

variable "org" {
  description = "Organization slug"
  type        = string
}

variable "repo" {
  description = "Repository name"
  type        = string
}

variable "workspace_path" {
  description = "Workspace path"
  type        = string
}

variable "branch" {
  description = "Git branch name"
  type        = string
}

variable "commit_sha" {
  description = "Git commit SHA"
  type        = string
}

variable "pr_number" {
  description = "Pull request number (null for named environments)"
  type        = number
  default     = null
}
```

You only need to declare the variables you use.

## Example Usage

```hcl
locals {
  is_production = var.environment == "main"
  is_transient  = var.environment_kind == "transient"
}

resource "aws_instance" "app" {
  instance_type = local.is_production ? "t3.large" : "t3.small"
  
  tags = {
    Environment = var.environment
    Workspace   = var.workspace_path
    CommitSha   = var.commit_sha
    Branch      = var.branch
  }
}

# Only create DNS records in named environments
resource "aws_route53_record" "app" {
  count = local.is_transient ? 0 : 1
  # ...
}

# Use commit SHA for container image tags
resource "kubernetes_deployment" "app" {
  spec {
    template {
      spec {
        container {
          image = "myregistry/${var.repo}:${var.commit_sha}"
        }
      }
    }
  }
}
```

## Variable Availability

| Variable | Named Environments | Transient Environments |
|----------|-------------------|------------------------|
| `environment` | Environment name (e.g., `"main"`) | Generated name (e.g., `"pr-123"`) |
| `environment_kind` | `"named"` | `"transient"` |
| `org` | Always set | Always set |
| `repo` | Always set | Always set |
| `workspace_path` | Always set | Always set |
| `branch` | Branch from trigger | PR head branch |
| `commit_sha` | Always set | Always set |
| `pr_number` | `null` | PR number |
