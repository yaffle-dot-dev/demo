# =============================================================================
# AWS WAF
# =============================================================================

resource "aws_wafv2_web_acl" "cloudfront" {
  provider = aws.global

  name        = "yaffle-frontend-${local.name_suffix}"
  description = "Filter common internet noise before requests reach CloudFront origins"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "allow-github-webhooks"
    priority = 5

    action {
      allow {}
    }

    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string         = "/api/webhooks/github"
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

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "allowGithubWebhooks"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-ip-reputation"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "awsManagedIpReputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-anonymous-ip"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAnonymousIpList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "awsManagedAnonymousIp"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-common"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # Terraform/OpenTofu CLI login uses a localhost redirect_uri, which trips
        # this managed SSRF query-argument rule. Count it here, then re-block it
        # everywhere except the exact TFC OAuth authorize route below.
        rule_action_override {
          name = "EC2MetaDataSSRF_QUERYARGUMENTS"

          action_to_use {
            count {}
          }
        }

        rule_action_override {
          name = "EC2MetaDataSSRF_BODY"

          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "awsManagedCommon"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "block-ec2-metadata-ssrf-except-tfc-oauth-authorize"
    priority = 31

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          label_match_statement {
            scope = "LABEL"
            key   = "awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_QueryArguments"
          }
        }

        statement {
          not_statement {
            statement {
              and_statement {
                statement {
                  byte_match_statement {
                    search_string         = "/tfc/oauth/authorize"
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
                    search_string         = "GET"
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
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "blockEc2MetadataSsrfExceptTfcOauthAuthorize"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "block-ec2-metadata-ssrf-body-except-tfc-oauth-token"
    priority = 32

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          label_match_statement {
            scope = "LABEL"
            key   = "awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body"
          }
        }

        statement {
          not_statement {
            statement {
              and_statement {
                statement {
                  byte_match_statement {
                    search_string         = "/tfc/oauth/token"
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
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "blockEc2MetadataSsrfBodyExceptTfcOauthToken"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-php"
    priority = 40

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesPHPRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "awsManagedPhp"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-known-bad-inputs"
    priority = 50

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "awsManagedKnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "frontendWebAcl"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "yaffle-frontend-${local.name_suffix}"
  }
}
