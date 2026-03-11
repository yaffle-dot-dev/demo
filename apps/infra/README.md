# Unified Frontend Infrastructure

This workspace manages the shared CloudFront distribution that routes traffic to all frontend applications.

## Architecture

```
yaffle.dev
├── /              → Marketing site (Astro static)
├── /app/*         → Web application (SvelteKit)
└── /api/*         → Control plane ALB (future)
```

## Ownership Model

| Resource | Owner | Notes |
|----------|-------|-------|
| S3 buckets | `apps/marketing/infra`, `apps/web/infra` | Each app owns its buckets |
| S3 bucket policies | `apps/infra` (this workspace) | CloudFront OAC access policies |
| CloudFront distribution | `apps/infra` (this workspace) | Unified routing |
| DNS records | `apps/infra` (this workspace) | Route53 A/AAAA records |
| SSL certificate | `infra/shared` | Wildcard cert for *.yaffle.dev |

**Important:** Do NOT add `aws_s3_bucket_policy` resources to app-specific infra workspaces. Bucket policies are managed here to grant CloudFront access. Adding policies elsewhere will cause Terraform state conflicts.

## Dependencies

This workspace depends on outputs from:

- `infra/shared` - Route53 zone ID, ACM certificate ARN
- `apps/marketing/infra` - S3 bucket names and ARNs
- `apps/web/infra` - S3 bucket names and ARNs

These dependencies are resolved via Yaffle's module registry.

## Cache Behaviors

| Path | Origin | TTL | Notes |
|------|--------|-----|-------|
| `/_astro/*` | marketing | 1 year | Astro immutable assets |
| `/app/_app/*` | web | 1 year | SvelteKit immutable assets |
| `/app/*` | web | 1 day | SvelteKit pages (SPA routing) |
| `/*` (default) | marketing | 1 day | Marketing pages (clean URLs) |

## Preview Environments

For PRs, Yaffle creates isolated preview environments:
- Domain: `{env}.preview.yaffle.dev`
- Separate CloudFront distribution
- Separate S3 buckets (from app workspaces)
- Automatic cleanup on PR close
