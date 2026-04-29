# ADR 0003: anonymous session abuse, quota, and garbage collection policy

## Status

Accepted

## Context

Anonymous session principals are part of Yaffle's local-first funnel, so we
need concrete service-protection defaults before opening the feature wider.

The policy must preserve first-run success while still protecting shared API and
storage surfaces from abuse.

Because anonymous principals are machine-local and disposable, hard per-
principal usage quotas are easy to evade and risk adding friction without
meaningful protection.

## Decision

### Access gate

Until the broader self-serve launch path is ready, local-first bootstrap and
publish APIs remain gated behind `YAFFLE_LOCAL_FIRST_FEATURE_TOKEN`.

- missing or invalid feature token fails closed
- if rate limiting or request protection cannot run, anonymous bootstrap and
  publish should fail closed rather than bypass controls

### Hard service protections

- anonymous-session bootstrap is rate-limited to 20 requests per minute per
  client IP
- execution-token mint is rate-limited to 120 requests per minute per client IP
- hosted output-module publish is rate-limited to 120 requests per minute per
  client IP
- local-first API request bodies are capped at 128 KiB
- hosted output modules must fit inside the same request-size cap; over-limit
  publishes are rejected

These are service-protection controls, not product-usage quotas.

Primary public-ingress rate limiting should still live at the edge
(CDN/WAF/reverse proxy) in production. App-level limits are a backstop for:

- protecting semantic endpoints before body parsing, auth, DB writes, or module
  publish work
- self-hosted or local deployments that may not have a dedicated WAF layer
- defense in depth if edge controls are missing or misconfigured

They are not meant to be Yaffle's only volumetric abuse defense.

Current infra direction:

- canonical `yaffle.dev` local-first ingress is rate-limited at the CloudFront
  WAF layer
- direct `api.*` control-plane ingress is backstopped with regional ALB WAF
  rules so preview/direct API traffic does not bypass edge protection entirely

### Execution credential TTLs

We need two different lifetime expectations.

- engine-managed per-workspace execution credentials are minted just-in-time
  before `tofu init` and stay short-lived with a 15 minute TTL
- shell-scoped credentials emitted by `yaffle tf login` must last long enough
  for raw `tofu init` + `plan` + `apply`; default TTL should be 4 hours

If Yaffle uses one shared credential type for both cases, the TTL must be long
enough for the raw-`tofu` shell session case before that path is considered
fully supported.

### No launch-time usage quotas

At launch we should not reject anonymous principals based on counts like:

- repo bindings per principal
- active environments per principal
- retained module versions per principal
- total hosted output-module bytes per principal
- publishes per hour per principal

Those limits are too easy to bypass by discarding the local anonymous
credential, while still creating real user-facing friction for legitimate use.

We should measure these dimensions in Axiom before turning any of them into hard
enforcement.

### Retention and garbage collection

- anonymous sessions expire after 14 days of inactivity
- successful bootstrap, execution-token mint, publish, and module-read activity
  update `last_seen_at`
- expired principals immediately lose the ability to mint new execution tokens
  or publish new output modules
- hosted output modules owned only by expired anonymous principals are retained
  for 7 additional days, then deleted by GC
- expired repo bindings are deleted with the owning anonymous principal's GC
  pass
- GC runs at least daily

At launch, retention should be age-based rather than count-based. If long-lived
anonymous artifact buildup becomes a real cost center, we can add stronger
retention policy after measurement.

### Operational signals

We must record enough signals to tune the policy later:

- anonymous session bootstrap count, rate-limit denials, and invalid feature
  token denials
- execution token mint count and endpoint rate-limit denials
- hosted output publish count, publish bytes, retained version count, and
  endpoint rate-limit denials
- active anonymous principal count and expired principal count
- repo bindings per anonymous principal
- active environments touched per anonymous principal
- stored hosted output-module bytes and object counts
- GC deletion counts and deleted bytes

The goal is to learn whether anonymous hosted modules are actually a meaningful
cost or abuse vector before adding stronger product limits.

## Consequences

- the funnel remains low-friction for legitimate local-first testing
- shared APIs stay protected by rate limits and size caps
- stale guest-owned module artifacts are explicitly ephemeral
- stronger storage or usage limits become a follow-on decision only if Axiom
  shows a real need
