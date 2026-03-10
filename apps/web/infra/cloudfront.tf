# =============================================================================
# CloudFront Distribution
# =============================================================================
# CloudFront distribution with S3 origin group for failover.
# Primary origin: us-east-1, Failover origin: us-west-2
# =============================================================================

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = var.is_preview ? "PriceClass_100" : "PriceClass_All"
  comment             = "Yaffle web - ${var.environment}"

  aliases = [local.site_domain]

  # ---------------------------------------------------------------------------
  # Origin Group for Failover
  # ---------------------------------------------------------------------------

  origin_group {
    origin_id = "s3-failover"

    failover_criteria {
      status_codes = [500, 502, 503, 504, 403, 404]
    }

    member {
      origin_id = "s3-primary"
    }

    member {
      origin_id = "s3-replica"
    }
  }

  # ---------------------------------------------------------------------------
  # Primary Origin (us-east-1)
  # ---------------------------------------------------------------------------

  origin {
    domain_name              = aws_s3_bucket.primary.bucket_regional_domain_name
    origin_id                = "s3-primary"
    origin_access_control_id = aws_cloudfront_origin_access_control.main.id
  }

  # ---------------------------------------------------------------------------
  # Replica Origin (us-west-2)
  # ---------------------------------------------------------------------------

  origin {
    domain_name              = aws_s3_bucket.replica.bucket_regional_domain_name
    origin_id                = "s3-replica"
    origin_access_control_id = aws_cloudfront_origin_access_control.main.id
  }

  # ---------------------------------------------------------------------------
  # Default Cache Behavior
  # ---------------------------------------------------------------------------

  default_cache_behavior {
    target_origin_id       = "s3-failover"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = aws_cloudfront_cache_policy.main.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id

    # SvelteKit SPA - handle client-side routing
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_routing.arn
    }
  }

  # ---------------------------------------------------------------------------
  # Static Assets Cache Behavior
  # ---------------------------------------------------------------------------

  ordered_cache_behavior {
    path_pattern           = "_app/*"
    target_origin_id       = "s3-failover"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Immutable assets - long cache
    cache_policy_id          = aws_cloudfront_cache_policy.immutable.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id
  }

  # ---------------------------------------------------------------------------
  # Custom Error Responses for SPA
  # ---------------------------------------------------------------------------

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  # ---------------------------------------------------------------------------
  # SSL/TLS Configuration
  # ---------------------------------------------------------------------------

  viewer_certificate {
    acm_certificate_arn      = local.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ---------------------------------------------------------------------------
  # Restrictions
  # ---------------------------------------------------------------------------

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = {
    Name = "yaffle-web-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# Cache Policies
# -----------------------------------------------------------------------------

resource "aws_cloudfront_cache_policy" "main" {
  name        = "yaffle-web-default-${local.name_suffix}"
  comment     = "Default cache policy for yaffle-web"
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
  name        = "yaffle-web-immutable-${local.name_suffix}"
  comment     = "Long cache for immutable assets (_app/*)"
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

# -----------------------------------------------------------------------------
# Origin Request Policy (AWS Managed)
# -----------------------------------------------------------------------------

data "aws_cloudfront_origin_request_policy" "cors_s3" {
  name = "Managed-CORS-S3Origin"
}

# -----------------------------------------------------------------------------
# CloudFront Function for SPA Routing
# -----------------------------------------------------------------------------

resource "aws_cloudfront_function" "spa_routing" {
  name    = "yaffle-web-spa-routing-${local.name_suffix}"
  runtime = "cloudfront-js-2.0"
  comment = "Handle SPA routing for SvelteKit"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // If the URI has a file extension, serve it directly
      if (uri.includes('.')) {
        return request;
      }

      // For paths without extensions (SPA routes), check for index.html
      if (!uri.endsWith('/')) {
        uri += '/';
      }
      request.uri = uri + 'index.html';

      return request;
    }
  EOF
}

# -----------------------------------------------------------------------------
# Route53 DNS Record
# -----------------------------------------------------------------------------

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
