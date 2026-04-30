locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = module.site_docs.aws_cloudfront_origin_access_control.this
  id       = "ESRBYK5DOVB98"
}

import {
  for_each = local.import_main
  to       = module.site_marketing.aws_cloudfront_origin_access_control.this
  id       = "E1KXO7XDC998HC"
}

import {
  for_each = local.import_main
  to       = aws_cloudfront_cache_policy.default
  id       = "2c7d2ce2-8db2-43fa-a3d8-7e06d1585c7c"
}

import {
  for_each = local.import_main
  to       = aws_cloudfront_cache_policy.immutable
  id       = "7bcf9bd7-a035-4eff-b72e-cb02d6d935e4"
}

import {
  for_each = local.import_main
  to       = aws_cloudfront_function.static_routing
  id       = "yaffle-static-routing-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_cloudfront_distribution.main
  id       = "EWVN2QG1SE6JF"
}

import {
  for_each = local.import_main
  to       = aws_iam_role.invalidation
  id       = "yaffle-deploy-invalidation-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.invalidation_cloudfront
  id       = "yaffle-deploy-invalidation-main-use1:cloudfront-invalidation"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_policy.marketing_primary
  id       = "yaffle-marketing-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_policy.marketing_replica
  id       = "yaffle-marketing-main-usw2"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_policy.docs_primary
  id       = "yaffle-docs-main-use1"
}

import {
  for_each = local.import_main
  to       = aws_s3_bucket_policy.docs_replica
  id       = "yaffle-docs-main-usw2"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.main
  id       = "Z0749074TAIKLLRRH3OM_yaffle.dev_A"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.main_aaaa
  id       = "Z0749074TAIKLLRRH3OM_yaffle.dev_AAAA"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.www[0]
  id       = "Z0749074TAIKLLRRH3OM_www.yaffle.dev_A"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.www_aaaa[0]
  id       = "Z0749074TAIKLLRRH3OM_www.yaffle.dev_AAAA"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.main
  id       = "${local.cloudflare_zone_id}/6272db27d14d290f4c4f0c3156337662"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.www[0]
  id       = "${local.cloudflare_zone_id}/6c7fc12a49ae3832681868e0cfd82a2f"
}
