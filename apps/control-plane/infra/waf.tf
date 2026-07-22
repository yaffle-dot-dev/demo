# =============================================================================
# Regional WAF for direct control-plane API access
# =============================================================================
# CloudFront is the primary edge for canonical `yaffle.dev` traffic, but direct
# `api.*` requests and preview API hosts still hit the ALB. This regional ACL is
# a direct-ingress backstop for those hosts.

locals {
  # AWS WAF rate-based rules use a 5 minute rolling window here, so these
  # thresholds are the 5 minute equivalents of our app-level local-first limits.
  local_first_direct_rate_limits = {
    anonymous_session_bootstrap = 100
    execution_token_mint        = 600
    output_module_publish       = 600
  }
}

resource "aws_wafv2_web_acl" "control_plane_direct_api" {
  name        = "yaffle-control-plane-direct-api-${local.name_suffix}"
  description = "Rate-limit direct local-first API ingress before requests reach the control-plane service"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit-local-first-bootstrap-direct-api"
    priority = 10

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = local.local_first_direct_rate_limits.anonymous_session_bootstrap
        aggregate_key_type = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = local.api_domain
                positional_constraint = "EXACTLY"

                field_to_match {
                  single_header {
                    name = "host"
                  }
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "/api/sessions/anonymous"
                positional_constraint = "EXACTLY"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rateLimitLocalFirstBootstrapDirectApi"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-local-first-execution-token-direct-api"
    priority = 20

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = local.local_first_direct_rate_limits.execution_token_mint
        aggregate_key_type = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = local.api_domain
                positional_constraint = "EXACTLY"

                field_to_match {
                  single_header {
                    name = "host"
                  }
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "/api/execution-tokens"
                positional_constraint = "EXACTLY"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rateLimitLocalFirstExecutionTokenDirectApi"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-local-first-output-module-publish-direct-api"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = local.local_first_direct_rate_limits.output_module_publish
        aggregate_key_type = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = local.api_domain
                positional_constraint = "EXACTLY"

                field_to_match {
                  single_header {
                    name = "host"
                  }
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "/api/output-modules"
                positional_constraint = "EXACTLY"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "PUT"
                positional_constraint = "EXACTLY"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rateLimitLocalFirstOutputModulePublishDirectApi"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-public-cli-write-direct-api"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = local.api_domain
                positional_constraint = "EXACTLY"

                field_to_match {
                  single_header {
                    name = "host"
                  }
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              regex_match_statement {
                regex_string = "^/api/cloud/(cli/(authorize-requests|token)|converge)$"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"

                field_to_match {
                  method {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rateLimitPublicCliWriteDirectApi"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "controlPlaneDirectApiWebAcl"
    sampled_requests_enabled   = true
  }

  tags = {
    Name                    = "yaffle-control-plane-direct-api-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.load_balancer
  }
}

resource "aws_wafv2_web_acl_association" "control_plane_direct_api" {
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.control_plane_direct_api.arn
}
