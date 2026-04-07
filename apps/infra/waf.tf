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
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "awsManagedCommon"
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
