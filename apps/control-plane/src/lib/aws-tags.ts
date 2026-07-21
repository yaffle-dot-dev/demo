interface OrgTagContext {
  orgId: string
  orgSlug?: string
}

interface ResourceTagOptions {
  resourceClass: string
  extraTags?: Record<string, string>
}

export interface AwsTag {
  key: string
  value: string
}

/**
 * Build canonical tags for org-owned resources in Yaffle's AWS account.
 *
 * `yaffle:org-id` is the canonical attribution key used for billing and cleanup.
 */
export function buildOrgResourceTags(ctx: OrgTagContext, options: ResourceTagOptions): AwsTag[] {
  const tags: Record<string, string> = {
    project: "yaffle",
    managed_by: "yaffle",
    "yaffle:org-id": ctx.orgId,
    "yaffle:resource-class": options.resourceClass,
    ...options.extraTags,
  }

  if (ctx.orgSlug) {
    tags["yaffle:org-slug"] = ctx.orgSlug
  }

  return Object.entries(tags).map(([key, value]) => ({ key, value }))
}

export function toS3ObjectTagging(tags: AwsTag[]): string {
  const params = new URLSearchParams()
  for (const tag of tags) {
    params.set(tag.key, tag.value)
  }
  return params.toString()
}

export function toKmsTags(tags: AwsTag[]): Array<{ TagKey: string; TagValue: string }> {
  return tags.map((tag) => ({ TagKey: tag.key, TagValue: tag.value }))
}

export function toIamTags(tags: AwsTag[]): Array<{ Key: string; Value: string }> {
  return tags.map((tag) => ({ Key: tag.key, Value: tag.value }))
}

export function toSsmTags(tags: AwsTag[]): Array<{ Key: string; Value: string }> {
  return tags.map((tag) => ({ Key: tag.key, Value: tag.value }))
}
