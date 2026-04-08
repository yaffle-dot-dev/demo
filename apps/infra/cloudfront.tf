# =============================================================================
# CloudFront Distribution
# =============================================================================
# Unified CloudFront distribution with multiple origins:
# - Marketing site (/) - Astro static site
# - Docs site (/docs/*) - Astro/Starlight documentation
# - Web app (/app/*) - SvelteKit application
# - Control plane API (/api/*, /tfc/*, /.well-known/*) - Hono API via ALB
#
# Each static origin has failover to a replica region for high availability.
# =============================================================================

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = var.is_preview ? "PriceClass_100" : "PriceClass_All"
  comment             = "Yaffle frontend - ${var.environment}"

  aliases    = [local.site_domain, "www.${local.site_domain}"]
  web_acl_id = aws_wafv2_web_acl.cloudfront.arn

  # ===========================================================================
  # ORIGIN GROUPS (for failover)
  # ===========================================================================

  # Marketing site origin group
  origin_group {
    origin_id = module.site_marketing.failover_origin_id

    failover_criteria {
      status_codes = [500, 502, 503, 504, 403, 404]
    }

    member {
      origin_id = module.site_marketing.primary_origin_id
    }

    member {
      origin_id = module.site_marketing.replica_origin_id
    }
  }

  # Docs site origin group
  origin_group {
    origin_id = module.site_docs.failover_origin_id

    failover_criteria {
      status_codes = [500, 502, 503, 504, 403, 404]
    }

    member {
      origin_id = module.site_docs.primary_origin_id
    }

    member {
      origin_id = module.site_docs.replica_origin_id
    }
  }

  # ===========================================================================
  # ORIGINS
  # ===========================================================================

  # ---------------------------------------------------------------------------
  # Control Plane API (ALB)
  # ---------------------------------------------------------------------------

  origin {
    domain_name = local.api_domain
    origin_id   = "control-plane-api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # ---------------------------------------------------------------------------
  # Marketing Site Origins
  # ---------------------------------------------------------------------------

  origin {
    domain_name              = module.site_marketing.primary_bucket_domain
    origin_id                = module.site_marketing.primary_origin_id
    origin_access_control_id = module.site_marketing.origin_access_control_id
  }

  origin {
    domain_name              = module.site_marketing.replica_bucket_domain
    origin_id                = module.site_marketing.replica_origin_id
    origin_access_control_id = module.site_marketing.origin_access_control_id
  }

  # ---------------------------------------------------------------------------
  # Docs Site Origins
  # ---------------------------------------------------------------------------

  origin {
    domain_name              = module.site_docs.primary_bucket_domain
    origin_id                = module.site_docs.primary_origin_id
    origin_access_control_id = module.site_docs.origin_access_control_id
  }

  origin {
    domain_name              = module.site_docs.replica_bucket_domain
    origin_id                = module.site_docs.replica_origin_id
    origin_access_control_id = module.site_docs.origin_access_control_id
  }

  # ===========================================================================
  # CACHE BEHAVIORS
  # ===========================================================================

  # ---------------------------------------------------------------------------
  # Default: Marketing Site (/)
  # ---------------------------------------------------------------------------

  default_cache_behavior {
    target_origin_id       = module.site_marketing.failover_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.default.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.static_routing.arn
    }
  }

  # ---------------------------------------------------------------------------
  # Marketing: Immutable assets (_astro/*)
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = module.site_marketing.immutable_path_pattern
    target_origin_id       = module.site_marketing.failover_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.immutable.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id
  }

  # ---------------------------------------------------------------------------
  # Docs Site: /docs/*
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = module.site_docs.path_pattern
    target_origin_id       = module.site_docs.failover_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.default.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.static_routing.arn
    }
  }

  # ---------------------------------------------------------------------------
  # Docs: Immutable assets (/docs/_astro/*)
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = module.site_docs.immutable_path_pattern
    target_origin_id       = module.site_docs.failover_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.immutable.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id
  }

  # ---------------------------------------------------------------------------
  # Web App: /app/* (SSR via ALB)
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "/app/*"
    target_origin_id       = "control-plane-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  # ---------------------------------------------------------------------------
  # Control Plane API: /api/*
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "control-plane-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  # ---------------------------------------------------------------------------
  # Control Plane API: /tfc/*
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "/tfc/*"
    target_origin_id       = "control-plane-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  # ---------------------------------------------------------------------------
  # Control Plane API: /.well-known/*
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "/.well-known/*"
    target_origin_id       = "control-plane-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.default.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  # ===========================================================================
  # ERROR RESPONSES
  # ===========================================================================

  # For marketing site (static), return 404 page
  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 10
  }

  # ===========================================================================
  # SSL/TLS
  # ===========================================================================

  viewer_certificate {
    acm_certificate_arn      = local.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ===========================================================================
  # RESTRICTIONS
  # ===========================================================================

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = {
    Name = "yaffle-frontend-${local.name_suffix}"
  }
}

# =============================================================================
# Cache Policies
# =============================================================================

resource "aws_cloudfront_cache_policy" "default" {
  name        = "yaffle-frontend-default-${local.name_suffix}"
  comment     = "Default cache policy for yaffle frontend"
  default_ttl = 86400  # 1 day
  max_ttl     = 604800 # 7 days
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }

    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

resource "aws_cloudfront_cache_policy" "immutable" {
  name        = "yaffle-frontend-immutable-${local.name_suffix}"
  comment     = "Long cache for immutable assets"
  default_ttl = 31536000 # 1 year
  max_ttl     = 31536000
  min_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }

    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# =============================================================================
# Origin Request Policy (AWS Managed)
# =============================================================================

data "aws_cloudfront_origin_request_policy" "cors_s3" {
  name = "Managed-CORS-S3Origin"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# =============================================================================
# Origin Access Controls
# =============================================================================

# Marketing and Docs OACs are managed by their respective micro_site modules

# =============================================================================
# CloudFront Functions
# =============================================================================

# Static site: Append /index.html to clean URLs (shared by marketing, docs, etc.)
resource "aws_cloudfront_function" "static_routing" {
  name    = "yaffle-static-routing-${local.name_suffix}"
  runtime = "cloudfront-js-2.0"
  comment = "Append /index.html to clean URLs for static sites"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // If URI has a file extension, serve directly
      if (uri.includes('.')) {
        return request;
      }

      // Append /index.html for clean URLs
      if (!uri.endsWith('/')) {
        uri += '/';
      }
      request.uri = uri + 'index.html';

      return request;
    }
  EOF
}

# =============================================================================
# Route53 DNS Records
# =============================================================================

resource "aws_route53_record" "main" {
  zone_id = local.route53_zone_id
  name    = local.site_domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "main_aaaa" {
  zone_id = local.route53_zone_id
  name    = local.site_domain
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# =============================================================================
# Cloudflare DNS Records (Dual DNS)
# =============================================================================

resource "cloudflare_dns_record" "main" {
  zone_id = var.cloudflare_zone_id
  name    = local.site_domain
  type    = "CNAME"
  content = aws_cloudfront_distribution.main.domain_name
  ttl     = 1 # Auto TTL
  proxied = false
}

resource "cloudflare_dns_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = "www.${local.site_domain}"
  type    = "CNAME"
  content = aws_cloudfront_distribution.main.domain_name
  ttl     = 1 # Auto TTL
  proxied = false
}

resource "aws_route53_record" "www" {
  zone_id = local.route53_zone_id
  name    = "www.${local.site_domain}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "www_aaaa" {
  zone_id = local.route53_zone_id
  name    = "www.${local.site_domain}"
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
