# =============================================================================
# CloudFront Distribution
# =============================================================================
# Unified CloudFront distribution with multiple origins:
# - Marketing site (/) - Astro static site
# - Web app (/app/*) - SvelteKit application
# - API (/api/*) - Control plane ALB (future)
#
# Each origin has failover to a replica region for high availability.
# =============================================================================

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = var.is_preview ? "PriceClass_100" : "PriceClass_All"
  comment             = "Yaffle frontend - ${var.environment}"

  aliases = [local.site_domain]

  # ===========================================================================
  # ORIGIN GROUPS (for failover)
  # ===========================================================================

  # Marketing site origin group
  origin_group {
    origin_id = "marketing-failover"

    failover_criteria {
      status_codes = [500, 502, 503, 504, 403, 404]
    }

    member {
      origin_id = "marketing-primary"
    }

    member {
      origin_id = "marketing-replica"
    }
  }

  # Web app origin group
  origin_group {
    origin_id = "web-failover"

    failover_criteria {
      status_codes = [500, 502, 503, 504, 403, 404]
    }

    member {
      origin_id = "web-primary"
    }

    member {
      origin_id = "web-replica"
    }
  }

  # ===========================================================================
  # ORIGINS
  # ===========================================================================

  # ---------------------------------------------------------------------------
  # Marketing Site Origins
  # ---------------------------------------------------------------------------

  origin {
    domain_name              = local.marketing_primary_bucket_domain
    origin_id                = "marketing-primary"
    origin_access_control_id = aws_cloudfront_origin_access_control.marketing.id
  }

  origin {
    domain_name              = local.marketing_replica_bucket_domain
    origin_id                = "marketing-replica"
    origin_access_control_id = aws_cloudfront_origin_access_control.marketing.id
  }

  # ---------------------------------------------------------------------------
  # Web App Origins
  # ---------------------------------------------------------------------------

  origin {
    domain_name              = local.web_primary_bucket_domain
    origin_id                = "web-primary"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    domain_name              = local.web_replica_bucket_domain
    origin_id                = "web-replica"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  # ===========================================================================
  # CACHE BEHAVIORS
  # ===========================================================================

  # ---------------------------------------------------------------------------
  # Default: Marketing Site (/)
  # ---------------------------------------------------------------------------

  default_cache_behavior {
    target_origin_id       = "marketing-failover"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.default.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id

    # Astro static site - handle clean URLs
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.marketing_routing.arn
    }
  }

  # ---------------------------------------------------------------------------
  # Marketing: Immutable assets (_astro/*)
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "_astro/*"
    target_origin_id       = "marketing-failover"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.immutable.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id
  }

  # ---------------------------------------------------------------------------
  # Web App: /app/*
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "/app/*"
    target_origin_id       = "web-failover"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.default.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id

    # SvelteKit SPA - handle client-side routing
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.web_routing.arn
    }
  }

  # ---------------------------------------------------------------------------
  # Web App: Immutable assets (/app/_app/*)
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "/app/_app/*"
    target_origin_id       = "web-failover"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.immutable.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id

    # Strip /app prefix for S3
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.web_strip_prefix.arn
    }
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
  default_ttl = 86400    # 1 day
  max_ttl     = 604800   # 7 days
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

# =============================================================================
# Origin Access Controls
# =============================================================================

resource "aws_cloudfront_origin_access_control" "marketing" {
  name                              = "yaffle-marketing-${local.name_suffix}"
  description                       = "OAC for yaffle marketing S3 buckets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "yaffle-web-${local.name_suffix}"
  description                       = "OAC for yaffle web S3 buckets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# =============================================================================
# CloudFront Functions
# =============================================================================

# Marketing site: Astro static routing (clean URLs)
resource "aws_cloudfront_function" "marketing_routing" {
  name    = "yaffle-marketing-routing-${local.name_suffix}"
  runtime = "cloudfront-js-2.0"
  comment = "Handle clean URLs for Astro static site"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // If the URI has a file extension, serve it directly
      if (uri.includes('.')) {
        return request;
      }

      // For clean URLs, append /index.html
      if (!uri.endsWith('/')) {
        uri += '/';
      }
      request.uri = uri + 'index.html';

      return request;
    }
  EOF
}

# Web app: SvelteKit SPA routing (strip /app prefix, handle client routes)
resource "aws_cloudfront_function" "web_routing" {
  name    = "yaffle-web-routing-${local.name_suffix}"
  runtime = "cloudfront-js-2.0"
  comment = "Handle SPA routing for SvelteKit, strip /app prefix"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // Strip /app prefix for S3
      if (uri.startsWith('/app')) {
        uri = uri.substring(4) || '/';
      }

      // If the URI has a file extension, serve it directly
      if (uri.includes('.')) {
        request.uri = uri;
        return request;
      }

      // For SPA routes, check for index.html
      if (!uri.endsWith('/')) {
        uri += '/';
      }
      request.uri = uri + 'index.html';

      return request;
    }
  EOF
}

# Web app: Strip /app prefix for immutable assets
resource "aws_cloudfront_function" "web_strip_prefix" {
  name    = "yaffle-web-strip-prefix-${local.name_suffix}"
  runtime = "cloudfront-js-2.0"
  comment = "Strip /app prefix for S3 lookups"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;

      // Strip /app prefix for S3
      if (request.uri.startsWith('/app')) {
        request.uri = request.uri.substring(4) || '/';
      }

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
